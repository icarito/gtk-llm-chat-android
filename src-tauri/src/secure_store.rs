const SERVICE: &str = "org.fuentelibre.gtk-llm-chat-linux";
const ACCOUNT: &str = "omemo2_db_key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Could not access the desktop keyring".to_string())
}

#[tauri::command]
pub async fn omemo_key_get() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Unlock a Secret Service keyring to use OMEMO 2".to_string()),
    })
    .await
    .map_err(|_| "Could not read the OMEMO key".to_string())?
}

#[tauri::command]
pub async fn omemo_key_set(value: String) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid OMEMO storage key".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entry()?;
        match entry.get_password() {
            Ok(existing) if existing == value => return Ok(()),
            Ok(_) => return Err("An OMEMO storage key already exists".to_string()),
            Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err("Unlock a Secret Service keyring to use OMEMO 2".to_string()),
        }
        entry
            .set_password(&value)
            .map_err(|_| "Could not save the OMEMO key in the desktop keyring".to_string())
    })
    .await
    .map_err(|_| "Could not save the OMEMO key".to_string())?
}
