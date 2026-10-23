// Comandos que o app web pode chamar (a parte que faz o trabalho fica em android/, em Kotlin).
const COMMANDS: &[&str] = &[
    "pick_folder",
    "folder_info",
    "write_temp",
    "save",
    "take_opened",
    "read_opened",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
