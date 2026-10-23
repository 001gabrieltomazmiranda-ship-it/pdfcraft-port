use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use tauri_plugin_dialog::DialogExt;

mod net;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemPrinter {
    pub name: String,
    pub is_default: bool,
    pub port_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
async fn open_files(app: tauri::AppHandle, filters: Vec<FileFilter>) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file();

    for filter in filters {
        let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(filter.name, &exts);
    }

    builder.pick_files(move |paths| {
        let _ = tx.send(paths);
    });

    match rx.recv().map_err(|e| e.to_string())? {
        Some(paths) => {
            let mut result = Vec::new();
            for path in paths {
                let resolved_path = path.into_path().map_err(|e| e.to_string())?;
                result.push(resolved_path.display().to_string());
            }
            Ok(result)
        }
        None => Ok(vec![]),
    }
}

#[tauri::command]
async fn save_file(app: tauri::AppHandle, suggested_name: String, filters: Vec<FileFilter>) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().set_file_name(suggested_name);

    for filter in filters {
        let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(filter.name, &exts);
    }

    builder.save_file(move |path| {
        let _ = tx.send(path);
    });

    match rx.recv().map_err(|e| e.to_string())? {
        Some(path) => {
            let resolved_path = path.into_path().map_err(|e| e.to_string())?;
            Ok(resolved_path.display().to_string())
        }
        None => Err("No file selected".to_string()),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_temp_dir() -> String {
    env::temp_dir().display().to_string()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid URL scheme".to_string());
    }
    Err("Not supported on Android yet".to_string())
}

#[tauri::command]
fn get_system_printers() -> Result<Vec<SystemPrinter>, String> {
    Ok(vec![])
}

#[tauri::command]
fn print_pdf_file(_data: Vec<u8>, _printer_name: Option<String>) -> Result<(), String> {
    Err("Printing is not supported on Android yet".to_string())
}

#[derive(Debug, Serialize)]
pub struct HttpReply {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Pedido HTTP feito pelo app (sem CORS). Usado para o carimbo de tempo (TSA).
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<Vec<u8>>,
    timeout: Option<u64>,
) -> Result<HttpReply, String> {
    let headers: Vec<(String, String)> = headers.unwrap_or_default().into_iter().collect();
    let body = body.unwrap_or_default();
    let millis = timeout.unwrap_or(30000).clamp(1000, 120000);
    let reply = net::request(&method, &url, &headers, &body, std::time::Duration::from_millis(millis))?;
    Ok(HttpReply {
        status: reply.status,
        content_type: reply.content_type,
        body: reply.body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_pdfcraft_files::init())
        .invoke_handler(tauri::generate_handler![
            open_files,
            save_file,
            read_file,
            write_file,
            get_temp_dir,
            open_url,
            get_system_printers,
            print_pdf_file,
            http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
  }
