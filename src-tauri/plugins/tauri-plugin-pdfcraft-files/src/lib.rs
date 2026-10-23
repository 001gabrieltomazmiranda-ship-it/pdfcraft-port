//! PDFCraft no Android:
//! - salvar numa pasta escolhida pela pessoa, perguntando antes de substituir um arquivo;
//! - receber PDFs de outros apps ("Abrir com" e "Compartilhar").
//!
//! O trabalho é feito pela classe Kotlin `com.pdfcraft.files.FilesPlugin` (pasta `android/`).
//! No computador o plugin não faz nada.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pdfcraft-files")
        .setup(|_app, _api| {
            // Se a parte Android não carregar, o app abre do mesmo jeito
            // (o salvar volta a usar a janela do sistema).
            #[cfg(target_os = "android")]
            let _ = _api
                .register_android_plugin("com.pdfcraft.files", "FilesPlugin")
                .map_err(|error| eprintln!("pdfcraft-files: {error}"));
            Ok(())
        })
        .build()
}
