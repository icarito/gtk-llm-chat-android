import ExpoModulesCore

// iOS no tiene foreground service: mismas funciones que Android, sin efecto.
public final class XmppServiceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("XmppServiceModule")

    AsyncFunction("startService") { (_ jid: String) -> Bool in false }
    AsyncFunction("updateNotification") { (_ jid: String) -> Bool in false }
    AsyncFunction("stopService") { () -> Bool in true }
  }
}
