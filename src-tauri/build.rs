fn main() {
    #[cfg(target_os = "windows")]
    {
        let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("Could not generate Tauri build resources");
        return;
    }
    #[allow(unreachable_code)]
    tauri_build::build()
}
