# Política de privacidad — Exit XMPP Chat

Última actualización: 18 de octubre de 2026

Exit XMPP Chat (en adelante, "la app") es un cliente de mensajería XMPP de código
abierto. Esta política explica qué datos maneja la app y adónde van.

## Resumen

- La app **no tiene servidores propios**, no muestra publicidad y no incluye
  analítica ni rastreo.
- Tus mensajes viajan entre tu dispositivo y el **servidor XMPP que tú elijas**
  (por defecto, `hablar.fuentelibre.org`).
- Con el cifrado OMEMO activado, el contenido de los mensajes y adjuntos está
  cifrado de extremo a extremo: el servidor no puede leerlo.

## Datos que se guardan en tu dispositivo

- **Credenciales de tu cuenta XMPP** (JID y contraseña), en el almacenamiento
  seguro del sistema (Keychain en iOS, Keystore en Android) cuando está
  disponible.
- **Historial de mensajes y adjuntos descargados**, en una base de datos local.
- **Claves de cifrado OMEMO** (identidad, sesiones, confianza en dispositivos),
  en almacenamiento local cifrado.
- **Preferencias** de la app.

Estos datos no salen de tu dispositivo salvo hacia tu servidor XMPP según lo
descrito abajo. Se borran al desinstalar la app.

## Datos que se envían a tu servidor XMPP

Para funcionar como cliente de mensajería, la app envía a tu servidor XMPP: tu
inicio de sesión, tus mensajes (cifrados si OMEMO está activo), los archivos que
decidas enviar (subidos por HTTP Upload, cifrados si la conversación lo está),
tu presencia, tu foto de perfil si la cambias, y tus claves públicas OMEMO. El
tratamiento de esos datos en el servidor depende de quien lo opere; para
`hablar.fuentelibre.org`, el operador es Fuente Libre.

## Notificaciones push

Para avisarte de mensajes nuevos cuando la app está en segundo plano, la app
registra un **token de notificaciones** en tu servidor XMPP (XEP-0357). Cuando
llega un mensaje, el servidor envía la notificación a través de **Expo Push**,
que la entrega mediante **Apple Push Notification service** (iOS) o **Firebase
Cloud Messaging** (Android). La notificación puede incluir el nombre del
remitente y una vista previa del texto; los mensajes cifrados con OMEMO
llegan con un texto genérico, sin su contenido. Puedes desactivar las notificaciones en los
ajustes del sistema.

## Permisos del dispositivo

- **Cámara y fotos**: sólo cuando eliges tomar o enviar una foto, o cambiar tu
  foto de perfil.
- **Micrófono**: sólo mientras grabas una nota de voz.
- **Notificaciones**: para avisarte de mensajes nuevos.

## Actualizaciones (Android)

La versión de Android consulta los lanzamientos públicos del repositorio en
GitHub (`api.github.com`) para avisarte de nuevas versiones. Esa consulta no
incluye datos de tu cuenta.

## Enlaces que abres

Algunos agentes publican un enlace a su documentación ("cerebro"). Al abrirlo,
se carga en tu navegador y aplica la política de ese sitio.

## Menores

La app no está dirigida a menores de 13 años.

## Contacto

Preguntas sobre esta política: sebastian@hablar.fuentelibre.org o
<https://github.com/icarito/gtk-llm-chat-android/issues>.
