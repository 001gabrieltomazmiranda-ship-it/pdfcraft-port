# Motor de edição real do PDF (roda no PyMuPDF dentro do Pyodide).
# Recebe a lista de mudanças feitas na tela e grava no conteúdo da página:
# o texto antigo é removido de verdade (não é tapado) e o novo é escrito com a
# mesma fonte/tamanho/cor; imagens mudam de lugar/tamanho sem serem recriadas.
import pymupdf, json, re, difflib, base64, statistics

_SUBSET = re.compile(r"^[A-Z]{6}\+")


def _norm(name):
    name = _SUBSET.sub("", name or "")
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _base_family(name):
    n = _norm(name)
    for suffix in ("bolditalic", "boldoblique", "bold", "italic", "oblique", "regular", "book", "roman", "medium", "mt", "ps"):
        if n.endswith(suffix):
            n = n[: -len(suffix)]
    return n


def _hex_rgb(value):
    v = value.lstrip("#")
    return (int(v[0:2], 16) / 255.0, int(v[2:4], 16) / 255.0, int(v[4:6], 16) / 255.0)


def _int_rgb(c):
    c = int(c or 0)
    return (((c >> 16) & 255) / 255.0, ((c >> 8) & 255) / 255.0, (c & 255) / 255.0)


BUILTIN = {}


def _builtin(code):
    if code not in BUILTIN:
        BUILTIN[code] = pymupdf.Font(code)
    return BUILTIN[code]


def _builtin_code(name, flags, bold=None):
    n = _norm(name)
    b = bool(flags & 16) or "bold" in n or "black" in n or "heavy" in n
    if bold is not None:
        b = bold
    it = bool(flags & 2) or "italic" in n or "oblique" in n
    if "courier" in n or "mono" in n or (flags & 8):
        return "cobi" if b and it else "cobo" if b else "coit" if it else "cour"
    if "times" in n or "serif" in n and "sans" not in n or (flags & 4 and "sans" not in n):
        return "tibi" if b and it else "tibo" if b else "tiit" if it else "tiro"
    return "hebi" if b and it else "hebo" if b else "heit" if it else "helv"


class Fonts:
    """Fontes embutidas no documento, para reaproveitar a letra original."""

    def __init__(self, doc):
        self.doc = doc
        self.cache = {}
        self.by_name = {}
        for pno in range(len(doc)):
            for f in doc[pno].get_fonts(full=True):
                key = _norm(f[3])
                lst = self.by_name.setdefault(key, [])
                if f[0] not in lst:
                    lst.append(f[0])

    def _load(self, xref):
        if xref not in self.cache:
            font = None
            buf = None
            try:
                _bn, ext, _typ, content = self.doc.extract_font(xref)
                if content and ext not in ("n/a", ""):
                    font = pymupdf.Font(fontbuffer=content)
                    buf = content
            except Exception:
                font = None
            self.cache[xref] = (font, buf)
        return self.cache[xref]

    def pick(self, span_font, flags, chars, bold=None):
        """Escolhe a fonte para escrever `chars`. Devolve (chave, Font, buffer ou None, código builtin ou None)."""
        need = [c for c in set(chars) if not c.isspace()]
        names = []
        if bold is None or bold == bool(flags & 16):
            names.append(_norm(span_font))
        if bold is not None:
            fam = _base_family(span_font)
            for key in self.by_name:
                if _base_family(key) == fam and (("bold" in key) == bold) and key not in names:
                    names.append(key)
        for key in names:
            for xref in self.by_name.get(key, []):
                font, buf = self._load(xref)
                if font is None:
                    continue
                if all(font.has_glyph(ord(c)) for c in need):
                    return ("pcf%d" % xref, font, buf, None)
        code = _builtin_code(span_font, flags, bold)
        font = _builtin(code)
        if all(font.has_glyph(ord(c)) for c in need) and all(ord(c) < 256 or c in "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ" for c in need):
            return (code, font, None, code)
        uni = _builtin("china-s")
        return ("china-s", uni, None, "china-s")


def _to_mu(page, r):
    rect = pymupdf.Rect(r[0], r[1], r[2], r[3]) * page.transformation_matrix
    rect.normalize()
    return rect


def _spans_in(page_dict, region):
    """Trechos de texto (horizontais) cujo centro está dentro da área."""
    found = []
    for b in page_dict.get("blocks", []):
        for l in b.get("lines", []):
            d = l.get("dir", (1, 0))
            if abs(d[0] - 1) > 1e-3 or abs(d[1]) > 1e-3:
                continue
            for s in l.get("spans", []):
                if not s.get("text"):
                    continue
                r = pymupdf.Rect(s["bbox"])
                if r.is_empty:
                    continue
                c = pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
                if region.contains(c):
                    found.append(s)
    return found


def _lines_of(spans):
    """Agrupa os trechos em linhas (pela linha de base) e ordena."""
    spans = sorted(spans, key=lambda s: (round(s["origin"][1], 1), s["origin"][0]))
    lines = []
    for s in spans:
        if lines and abs(s["origin"][1] - lines[-1][0]["origin"][1]) <= 0.4 * max(s["size"], 1):
            lines[-1].append(s)
        else:
            lines.append([s])
    for line in lines:
        line.sort(key=lambda s: s["origin"][0])
    return lines


def _text_and_styles(lines, styles):
    """Texto original (linhas com \\n) e o estilo de cada letra."""
    chars = []
    st = []
    for li, line in enumerate(lines):
        if li:
            chars.append("\n")
            st.append(st[-1] if st else 0)
        prev = None
        for s in line:
            key = (s["font"], round(s["size"], 2), s["color"], s["flags"])
            if key not in styles:
                styles.append(key)
            idx = styles.index(key)
            if prev is not None:
                gap = s["bbox"][0] - prev["bbox"][2]
                if gap > 0.2 * s["size"] and not prev["text"].endswith(" ") and not s["text"].startswith(" "):
                    chars.append(" ")
                    st.append(idx)
            for ch in s["text"]:
                chars.append(ch)
                st.append(idx)
            prev = s
    return "".join(chars), st


def _map_styles(old, old_st, new):
    if not old_st:
        return [0] * len(new)
    sm = difflib.SequenceMatcher(None, old, new, autojunk=False)
    out = [None] * len(new)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out[j1:j2] = old_st[i1:i2]
        elif tag == "replace":
            for j in range(j1, j2):
                k = i1 + (j - j1) * (i2 - i1) // max(1, (j2 - j1))
                out[j] = old_st[min(i2 - 1, k)]
        elif tag == "insert":
            ref = old_st[i1 - 1] if i1 > 0 else old_st[0]
            for j in range(j1, j2):
                out[j] = ref
    return [o if o is not None else old_st[0] for o in out]


class Writer:
    """Escreve trechos de texto na página, cuidando das fontes inseridas."""

    def __init__(self, page, fonts):
        self.page = page
        self.fonts = fonts
        self.inserted = set()

    def font_for(self, style, chars, bold=None):
        name, flags = style[0], style[3]
        return self.fonts.pick(name, flags, chars, bold)

    def write(self, point, text, pick, size, color):
        key, font, buf, code = pick
        if not text.strip():
            return
        if buf is not None and key not in self.inserted:
            self.page.insert_font(fontname=key, fontbuffer=buf)
            self.inserted.add(key)
        elif code == "china-s" and key not in self.inserted:
            self.page.insert_font(fontname=key)
            self.inserted.add(key)
        self.page.insert_text(point, text, fontsize=size, fontname=key, color=color)


def _layout(text, st, styles, width, measure):
    """Quebra o texto em linhas que cabem na largura. Cada linha: lista de (texto, estilo)."""
    out = []
    pos = 0
    for para in text.split("\n"):
        pst = st[pos : pos + len(para)]
        pos += len(para) + 1
        tokens = re.findall(r"\S+|\s+", para)
        line = []  # lista de (char, estilo)
        line_w = 0.0
        i = 0
        for tok in tokens:
            tst = pst[i : i + len(tok)]
            i += len(tok)
            tw = measure(tok, tst)
            if tok.isspace():
                if line:
                    line.extend(zip(tok, tst))
                    line_w += tw
                continue
            if line and line_w + tw > width + 0.5:
                while line and line[-1][0].isspace():
                    line.pop()
                out.append(line)
                line, line_w = [], 0.0
            line.extend(zip(tok, tst))
            line_w += tw
        while line and line[-1][0].isspace():
            line.pop()
        out.append(line)
    runs = []
    for line in out:
        r = []
        for ch, s in line:
            if r and r[-1][1] == s:
                r[-1][0] += ch
            else:
                r.append([ch, s])
        runs.append(r)
    return runs


def apply_edits(in_path, out_path, ops_json):
    ops = json.loads(ops_json)
    doc = pymupdf.open(in_path)
    fonts = Fonts(doc)
    warnings = []
    by_page = {}
    for op in ops:
        by_page.setdefault(int(op["page"]), []).append(op)

    for pno in sorted(by_page):
        if pno < 0 or pno >= len(doc):
            continue
        page = doc[pno]
        page_ops = by_page[pno]
        pdict = page.get_text("dict")
        texts = []  # (op, lines, styles, orig_text, orig_st)
        redacted = False

        # 1) Texto existente: guarda como era e marca para remoção.
        for op in page_ops:
            if op["kind"] != "text":
                continue
            region = _to_mu(page, op["orig"]) + (-1.5, -1.5, 1.5, 1.5)
            spans = _spans_in(pdict, region)
            if not spans:
                warnings.append("text-not-found")
                continue
            lines = _lines_of(spans)
            styles = []
            otext, ost = _text_and_styles(lines, styles)
            for s in spans:
                r = pymupdf.Rect(s["bbox"])
                h = r.height
                page.add_redact_annot(pymupdf.Rect(r.x0 + 0.3, r.y0 + 0.25 * h, r.x1 - 0.3, r.y1 - 0.25 * h), fill=False)
                redacted = True
            texts.append((op, lines, styles, otext, ost))

        if redacted:
            page.apply_redactions(images=0, graphics=0, text=0)

        # 2) Imagens existentes: mover, redimensionar ou apagar.
        img_ops = [op for op in page_ops if op["kind"] == "image"]
        if img_ops:
            _edit_images(doc, page, img_ops, warnings)

        writer = Writer(page, fonts)

        # 3) Escreve de novo o texto alterado/movido.
        for op, lines, styles, otext, ost in texts:
            if op.get("deleted"):
                continue
            dx = float(op.get("dx", 0))
            dy = -float(op.get("dy", 0))  # PDF (y para cima) -> página (y para baixo)
            size_k = 1.0
            base_size = max(s[1] for s in styles)
            if op.get("scale"):
                size_k = max(0.1, min(10.0, float(op["scale"])))
            elif op.get("size"):
                size_k = float(op["size"]) / base_size if base_size else 1.0
            color = _hex_rgb(op["color"]) if op.get("color") else None
            bold = op.get("bold")
            first = lines[0][0]
            top_left = pymupdf.Point(min(s["bbox"][0] for l in lines for s in l), first["bbox"][1])
            new_text = op.get("text", otext)
            changed = op.get("changed") and new_text != otext

            if not changed:
                # Mesmo texto: cada trecho volta para o seu lugar (deslocado), com a letra original.
                for line in lines:
                    for s in line:
                        style = (s["font"], round(s["size"], 2), s["color"], s["flags"])
                        pick = writer.font_for(style, s["text"], bold)
                        ox = top_left.x + (s["origin"][0] - top_left.x) * size_k + dx
                        oy = top_left.y + (s["origin"][1] - top_left.y) * size_k + dy
                        writer.write(pymupdf.Point(ox, oy), s["text"], pick, s["size"] * size_k, color or _int_rgb(s["color"]))
                continue

            nst = _map_styles(otext, ost, new_text)
            picks = {}

            def pick_for(si, chars):
                k = (si, frozenset(chars))
                if k not in picks:
                    picks[k] = writer.font_for(styles[si], chars, bold)
                return picks[k]

            used = {}
            for ch, si in zip(new_text, nst):
                used.setdefault(si, set()).add(ch)
            style_pick = {si: writer.font_for(styles[si], "".join(chs), bold) for si, chs in used.items()}

            def measure(txt, sts):
                w = 0.0
                for ch, si in zip(txt, sts):
                    w += style_pick[si][1].text_length(ch, fontsize=styles[si][1] * size_k)
                return w

            width = float(op.get("width") or (_to_mu(page, op["orig"]).width)) + 1.0
            if len(lines) == 1 and "\n" not in new_text and not op.get("resized"):
                # linha única (título, rótulo): cresce para a direita até a margem, como no Acrobat
                start_x = top_left.x + (min(l[0]["origin"][0] for l in lines) - top_left.x) * size_k + dx
                width = max(width, page.rect.x1 - 20 - start_x)
            runs = _layout(new_text, nst, styles, width, measure)
            if len(lines) > 1:
                pitch = statistics.median(
                    [lines[i + 1][0]["origin"][1] - lines[i][0]["origin"][1] for i in range(len(lines) - 1)]
                ) * size_k
            else:
                pitch = base_size * size_k * 1.2
            x0 = min(l[0]["origin"][0] for l in lines)
            ox0 = top_left.x + (x0 - top_left.x) * size_k + dx
            oy = top_left.y + (first["origin"][1] - top_left.y) * size_k + dy
            # alinhamento do bloco (só dá para saber com 2+ linhas de tamanhos diferentes)
            lefts = [l[0]["bbox"][0] for l in lines]
            rights = [l[-1]["bbox"][2] for l in lines]
            mids = [(a + b) / 2 for a, b in zip(lefts, rights)]
            align = "left"
            if len(lines) >= 2 and max(lefts) - min(lefts) > 2.0:
                if max(rights) - min(rights) < 1.5:
                    align = "right"
                elif max(mids) - min(mids) < 1.5:
                    align = "center"
            right_edge = top_left.x + (max(rights) - top_left.x) * size_k + dx
            middle = top_left.x + ((min(lefts) + max(rights)) / 2 - top_left.x) * size_k + dx
            for line in runs:
                lw = sum(style_pick[si][1].text_length(t, fontsize=styles[si][1] * size_k) for t, si in line)
                x = ox0 if align == "left" else right_edge - lw if align == "right" else middle - lw / 2
                for txt, si in line:
                    st = styles[si]
                    pk = style_pick[si]
                    size = st[1] * size_k
                    writer.write(pymupdf.Point(x, oy), txt, pk, size, color or _int_rgb(st[2]))
                    x += pk[1].text_length(txt, fontsize=size)
                oy += pitch

        # 4) Texto novo.
        for op in page_ops:
            if op["kind"] != "newtext" or not op.get("text", "").strip():
                continue
            size = float(op.get("size") or 12)
            color = _hex_rgb(op.get("color") or "#000000")
            style = ("Helvetica-Bold" if op.get("bold") else "Helvetica", size, 0, 16 if op.get("bold") else 0)
            pk = writer.font_for(style, op["text"], bool(op.get("bold")))
            box = _to_mu(page, op["rect"])
            runs = _layout(op["text"], [0] * len(op["text"]), [style], max(box.width, size) + 1.0,
                           lambda t, s: pk[1].text_length(t, fontsize=size))
            y = box.y0 + size * pk[1].ascender if pk[1].ascender else box.y0 + size * 0.8
            for line in runs:
                txt = "".join(t for t, _ in line)
                writer.write(pymupdf.Point(box.x0, y), txt, pk, size, color)
                y += size * 1.2

        # 5) Imagem nova.
        for op in page_ops:
            if op["kind"] != "newimage":
                continue
            try:
                page.insert_image(_to_mu(page, op["rect"]), stream=base64.b64decode(op["data"]), keep_proportion=False)
            except Exception:
                warnings.append("newimage-failed")

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    return json.dumps({"ok": True, "warnings": warnings})


def _fmt(v):
    s = ("%.5f" % v).rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def _edit_images(doc, page, img_ops, warnings):
    infos = page.get_image_info(xrefs=True)
    names = {}
    for item in page.get_images(full=True):
        names.setdefault(item[0], (item[7], item[9]))
    plan = []  # (xref, ordem entre as do mesmo xref, op, info)
    for op in img_ops:
        target = _to_mu(page, op["orig"])
        best, score = None, 0.0
        for info in infos:
            r = pymupdf.Rect(info["bbox"])
            inter = (r & target).get_area()
            union = r.get_area() + target.get_area() - inter
            iou = inter / union if union > 0 else 0
            if iou > score:
                best, score = info, iou
        if best is None or score < 0.5 or not best.get("xref"):
            warnings.append("image-not-editable")
            continue
        xref = best["xref"]
        name, referencer = names.get(xref, (None, None))
        if not name or referencer:
            warnings.append("image-not-editable")
            continue
        same = sorted([i for i in infos if i.get("xref") == xref], key=lambda i: i["number"])
        k = [i["number"] for i in same].index(best["number"])
        plan.append((xref, name, k, len(same), op, best))
    if not plan:
        return
    page.clean_contents()
    cx = page.get_contents()
    if len(cx) != 1:
        warnings.append("image-not-editable")
        return
    stream = doc.xref_stream(cx[0])
    tm = page.transformation_matrix
    edits = []  # (start, end, replacement)
    for xref, name, k, total, op, info in plan:
        pat = re.compile(rb"/" + re.escape(name.encode("latin-1")) + rb"\s+Do\b")
        occ = list(pat.finditer(stream))
        if len(occ) != total:
            warnings.append("image-not-editable")
            continue
        m = occ[k]
        if op.get("deleted"):
            edits.append((m.start(), m.end(), b""))
            continue
        old = pymupdf.Rect(info["bbox"])
        new = _to_mu(page, op["rect"])
        if old.width <= 0 or old.height <= 0:
            continue
        sx, sy = new.width / old.width, new.height / old.height
        a_mu = pymupdf.Matrix(sx, 0, 0, sy, new.x0 - old.x0 * sx, new.y0 - old.y0 * sy)
        a_pdf = tm * a_mu * ~tm
        # a matriz do PyMuPDF já vem com o quadrado da imagem virado (y para baixo)
        c_pdf = pymupdf.Matrix(1, 0, 0, -1, 0, 1) * pymupdf.Matrix(info["transform"]) * ~tm
        mm = c_pdf * a_pdf * ~c_pdf
        cm = " ".join(_fmt(v) for v in (mm.a, mm.b, mm.c, mm.d, mm.e, mm.f)).encode()
        edits.append((m.start(), m.end(), b"q " + cm + b" cm " + m.group(0) + b" Q"))
    if not edits:
        return
    out = bytearray(stream)
    for start, end, rep in sorted(edits, key=lambda e: e[0], reverse=True):
        out[start:end] = rep
    doc.update_stream(cx[0], bytes(out))
