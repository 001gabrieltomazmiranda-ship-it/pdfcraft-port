// PDFCraft: salvar arquivos numa pasta escolhida pela pessoa (com aviso de "já existe")
// e receber PDFs abertos por outros apps ("Abrir com" / "Compartilhar").

package com.pdfcraft.files

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile

@InvokeArg
class PickFolderArgs {
  var initial: String? = null
}

@InvokeArg
class FolderArgs {
  var folder: String? = null
}

@InvokeArg
class WriteTempArgs {
  var data: String? = null
  var append: Boolean = false
}

@InvokeArg
class SaveArgs {
  var folder: String? = null
  var name: String? = null
  var overwrite: Boolean = false
}

@InvokeArg
class ReadOpenedArgs {
  var offset: Long = 0
  var length: Int = 0
}

@TauriPlugin
class FilesPlugin(private val activity: Activity) : Plugin(activity) {
  /** PDF recebido de outro app, esperando o app web pedir. */
  @Volatile
  private var pending: Uri? = null

  companion object {
    /** Último arquivo recebido neste processo (evita abrir de novo quando a tela é recriada). */
    @Volatile
    private var lastReceived: String? = null

    private const val SAVE_TEMP = "pdfcraft-save.tmp"
    private const val OPENED_COPY = "pdfcraft-opened.pdf"
    private const val EXTERNAL_STORAGE = "com.android.externalstorage.documents"
  }

  override fun load(webView: WebView) {
    super.load(webView)
    receive(activity.intent, false)
  }

  override fun onNewIntent(intent: Intent) {
    receive(intent, true)
  }

  override fun onDestroy(activity: AppCompatActivity) {
    // saiu do app de verdade: o mesmo arquivo pode ser aberto de novo depois
    if (activity.isFinishing) {
      lastReceived = null
    }
  }

  private fun receive(intent: Intent?, isNew: Boolean) {
    if (intent == null) return
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    val uri: Uri? = when (intent.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> streamOf(intent)
      else -> null
    }
    if (uri == null) return
    val key = uri.toString()
    if (!isNew && key == lastReceived) return
    lastReceived = key
    pending = uri
  }

  @Suppress("DEPRECATION")
  private fun streamOf(intent: Intent): Uri? {
    return try {
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    } catch (e: Exception) {
      null
    }
  }

  // ------------------------------------------------------------ abrir com

  /** Copia o PDF recebido para o cache do app e diz nome e tamanho. */
  @Command
  fun takeOpened(invoke: Invoke) {
    val uri = pending
    pending = null
    if (uri == null) {
      invoke.resolve(JSObject().put("found", false))
      return
    }
    Thread {
      try {
        val target = File(activity.cacheDir, OPENED_COPY)
        val input: InputStream = activity.contentResolver.openInputStream(uri)
          ?: throw Exception("cannot-read")
        input.use { inp ->
          FileOutputStream(target).use { out -> inp.copyTo(out, 64 * 1024) }
        }
        val name = displayName(uri) ?: "documento.pdf"
        val result = JSObject()
        result.put("found", true)
        result.put("name", name)
        result.put("size", target.length())
        invoke.resolve(result)
      } catch (e: Throwable) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  /** Lê um pedaço da cópia do PDF recebido (em base64). */
  @Command
  fun readOpened(invoke: Invoke) {
    val args = invoke.parseArgs(ReadOpenedArgs::class.java)
    Thread {
      try {
        val file = File(activity.cacheDir, OPENED_COPY)
        val size = file.length()
        val start = args.offset.coerceIn(0L, size)
        val count = minOf(args.length.toLong().coerceAtLeast(0L), size - start).toInt()
        val buffer = ByteArray(count)
        RandomAccessFile(file, "r").use { raf ->
          raf.seek(start)
          raf.readFully(buffer)
        }
        val result = JSObject()
        result.put("data", Base64.encodeToString(buffer, Base64.NO_WRAP))
        result.put("size", size)
        invoke.resolve(result)
      } catch (e: Throwable) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  // ------------------------------------------------------------ pasta para salvar

  @Command
  fun pickFolder(invoke: Invoke) {
    val args = invoke.parseArgs(PickFolderArgs::class.java)
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
    intent.addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    )
    try {
      val initial = args.initial
      val start: Uri = if (!initial.isNullOrEmpty()) {
        Uri.parse(initial)
      } else {
        DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE, "primary:Documents")
      }
      intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, start)
    } catch (e: Exception) {
      // sem pasta inicial: o seletor abre onde quiser
    }
    startActivityForResult(invoke, intent, "folderPicked")
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().put("picked", false))
      return
    }
    try {
      val resolver = activity.contentResolver
      resolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
      // só fica guardado o acesso à pasta escolhida agora
      for (perm in resolver.persistedUriPermissions) {
        if (perm.uri != uri) {
          try {
            resolver.releasePersistableUriPermission(
              perm.uri,
              Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
          } catch (e: Exception) {
          }
        }
      }
      val out = JSObject()
      out.put("picked", true)
      out.put("uri", uri.toString())
      out.put("name", folderName(uri) ?: "")
      invoke.resolve(out)
    } catch (e: Throwable) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  /** A pasta guardada ainda pode ser usada? E qual o nome dela? */
  @Command
  fun folderInfo(invoke: Invoke) {
    val args = invoke.parseArgs(FolderArgs::class.java)
    val out = JSObject()
    try {
      val tree = Uri.parse(args.folder ?: "")
      val allowed = activity.contentResolver.persistedUriPermissions.any {
        it.uri == tree && it.isWritePermission
      }
      val name = if (allowed) folderName(tree) else null
      out.put("ok", allowed && name != null)
      out.put("name", name ?: "")
    } catch (e: Throwable) {
      out.put("ok", false)
      out.put("name", "")
    }
    invoke.resolve(out)
  }

  /** Recebe o arquivo em pedaços (base64) num arquivo temporário do app. */
  @Command
  fun writeTemp(invoke: Invoke) {
    val args = invoke.parseArgs(WriteTempArgs::class.java)
    Thread {
      try {
        val bytes = Base64.decode(args.data ?: "", Base64.DEFAULT)
        val file = File(activity.cacheDir, SAVE_TEMP)
        FileOutputStream(file, args.append).use { it.write(bytes) }
        invoke.resolve(JSObject().put("size", file.length()))
      } catch (e: Throwable) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  /**
   * Grava o temporário na pasta com o nome pedido.
   * Se já existir um arquivo com esse nome e não for para substituir, responde "exists".
   */
  @Command
  fun save(invoke: Invoke) {
    val args = invoke.parseArgs(SaveArgs::class.java)
    Thread {
      try {
        val name = (args.name ?: "").trim()
        if (name.isEmpty() || name.contains('/')) throw Exception("bad-name")
        val tree = Uri.parse(args.folder ?: throw Exception("no-folder"))
        val temp = File(activity.cacheDir, SAVE_TEMP)
        if (!temp.exists()) throw Exception("no-data")
        val resolver = activity.contentResolver
        val parentId = DocumentsContract.getTreeDocumentId(tree)
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, parentId)
        val existing = findChild(tree, parentId, name)
        if (existing != null && !args.overwrite) {
          val out = JSObject()
          out.put("status", "exists")
          out.put("name", existing.second)
          invoke.resolve(out)
          return@Thread
        }
        val target: Uri = existing?.first
          ?: DocumentsContract.createDocument(resolver, parent, mimeOf(name), name)
          ?: throw Exception("cannot-create")
        val output = openForWrite(target, existing != null)
        output.use { out -> FileInputStream(temp).use { inp -> inp.copyTo(out, 64 * 1024) } }
        temp.delete()
        val out = JSObject()
        out.put("status", "saved")
        out.put("name", displayName(target) ?: name)
        out.put("folder", folderName(tree) ?: "")
        out.put("uri", target.toString())
        invoke.resolve(out)
      } catch (e: SecurityException) {
        invoke.reject("no-access")
      } catch (e: Throwable) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  // ------------------------------------------------------------ ajudantes

  /** Arquivo com o mesmo nome dentro da pasta (sem diferenciar maiúsculas, como o Android). */
  private fun findChild(tree: Uri, parentId: String, name: String): Pair<Uri, String>? {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE
    )
    activity.contentResolver.query(children, projection, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0) ?: continue
        val childName = c.getString(1) ?: continue
        if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) continue
        if (childName.equals(name, ignoreCase = true)) {
          return Pair(DocumentsContract.buildDocumentUriUsingTree(tree, id), childName)
        }
      }
    }
    return null
  }

  private fun openForWrite(uri: Uri, replacing: Boolean): OutputStream {
    val resolver = activity.contentResolver
    val modes = if (replacing) arrayOf("wt", "rwt", "w") else arrayOf("w", "wt")
    var last: Exception? = null
    for (mode in modes) {
      try {
        val stream = resolver.openOutputStream(uri, mode)
        if (stream != null) return stream
      } catch (e: SecurityException) {
        throw e
      } catch (e: Exception) {
        last = e
      }
    }
    throw last ?: Exception("cannot-write")
  }

  private fun mimeOf(name: String): String {
    val dot = name.lastIndexOf('.')
    val ext = if (dot >= 0) name.substring(dot + 1).lowercase() else ""
    if (ext == "pdf") return "application/pdf"
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun folderName(tree: Uri): String? {
    return try {
      val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      queryString(doc, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
    } catch (e: Exception) {
      null
    }
  }

  private fun displayName(uri: Uri): String? {
    return try {
      queryString(uri, OpenableColumns.DISPLAY_NAME)
    } catch (e: Exception) {
      null
    }
  }

  private fun queryString(uri: Uri, column: String): String? {
    activity.contentResolver.query(uri, arrayOf(column), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) {
        return c.getString(0)
      }
    }
    return null
  }
}
