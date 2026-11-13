# Reader – MangaVault für iPhone & iPad

Eine Web-App, die verschlüsselte MangaVault-Exporte (`.mvx`) auf iPhone und iPad **nur liest**.
Sie läuft komplett auf dem Gerät und offline. Es wird nichts hochgeladen.

## So funktioniert's

1. Am PC in MangaVault: **Einstellungen → Exportieren …**, Serien auswählen, Export-Passwort vergeben.
   Tipp: Wähle einen neutralen Dateinamen wie `Backup.mvx`.
2. Die `.mvx`-Datei aufs iPhone/iPad bringen, z. B. per AirDrop, iCloud Drive oder USB-Kabel (Finder/iTunes), in die **Dateien**-App.
3. Den Reader öffnen → **Exportdatei öffnen** → Datei wählen → Export-Passwort eingeben.

**Bedienung im Reader:**
- Rand antippen oder wischen: blättern (richtet sich nach der Leserichtung)
- Mitte antippen: Leisten ein/aus
- Doppeltippen: Zoom (2,5×), mit zwei Fingern stufenlos bis 5×, gezoomt mit einem Finger verschieben
- Oben: Ansicht (Seite oder Vertikal), Leserichtung, Seitenübersicht. Unten: Seiten-Slider und Kapitelwechsel.

## Sicherheit

| Bereich | Umsetzung |
|---|---|
| Datei | bleibt unverändert und verschlüsselt. Jede Seite wird erst beim Anzeigen geprüft (HMAC-SHA256) und im Arbeitsspeicher entschlüsselt (AES-256). |
| Schlüssel | PBKDF2-HMAC-SHA512 aus dem Export-Passwort (Web Crypto API des Browsers) |
| Lesefortschritt | lokal auf dem Gerät, AES-256-GCM-verschlüsselt mit einem Schlüssel aus dem Export-Passwort. Ohne Titel und ohne Dateinamen. |
| Sperren | beim Wechsel in eine andere App oder zum Home-Bildschirm sowie nach 10 Min. ohne Bedienung. Der Inhalt wird sofort ausgeblendet, alle entschlüsselten Daten werden verworfen. |
| Netzwerk | keine Verbindungen außer zum Laden der App selbst. Content-Security-Policy verbietet fremde Skripte und Server. |
| Offline | Der Service Worker speichert nur die App-Dateien, niemals Manga-Daten. |

**Grenzen (ehrlich):**
- Screenshots und Bildschirmaufnahmen lassen sich im Browser nicht blockieren.
- Bei jedem Start bzw. nach dem Sperren musst du die Datei erneut wählen bzw. das Passwort erneut eingeben. iOS erlaubt Web-Apps keinen dauerhaften Dateizugriff.
- iOS kopiert eine gewählte Datei beim Öffnen intern. Bei sehr großen Exporten (mehrere GB) dauert das und braucht vorübergehend Speicherplatz. Für das iPhone lieber kleinere Exporte machen, z. B. pro Serie.
- Löschst du die App vom Home-Bildschirm oder die Website-Daten, ist nur der Lesefortschritt weg. Die `.mvx` bleibt erhalten.

## Veröffentlichen mit GitHub Pages (kostenlos)

Die App braucht eine **https-Adresse**, sonst lässt sie sich auf iOS nicht installieren und die Verschlüsselungsfunktionen fehlen.
Hochgeladen wird **nur der Programmcode** aus diesem Ordner, nie deine Mangas.

1. Auf <https://github.com> ein kostenloses Konto anlegen.
2. Oben rechts **+ → New repository**, Name z. B. `reader`, **Public**, dann **Create repository**.
3. Auf der neuen Seite **uploading an existing file** anklicken und **alle Dateien und den Ordner `icons`** aus diesem Ordner hineinziehen (`index.html`, `app.js`, `app.css`, `mvx.js`, `sw.js`, `manifest.webmanifest`, `icons/…`). Diese README musst du nicht hochladen. Dann **Commit changes**.
4. **Settings → Pages**: unter *Branch* `main` und `/ (root)` wählen, dann **Save**.
5. Nach 1–2 Minuten ist die App unter `https://DEINNAME.github.io/reader/` erreichbar.
6. Auf iPhone/iPad in **Safari** öffnen → **Teilen → Zum Home-Bildschirm**.

**Updates:** Geänderte Dateien im Repository ersetzen und in `sw.js` die Versionsnummer `reader-v1` erhöhen (z. B. `reader-v2`).
Die App lädt Updates beim nächsten Start mit Internetverbindung.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche |
| `app.css` | Design (dunkel, passend zu MangaVault) |
| `app.js` | Bibliothek, Reader, Gesten, Seitenübersicht, Sperre, Lesefortschritt |
| `mvx.js` | Lesen und Prüfen des `.mvx`-Formats (siehe `MangaVault\src\Transfer.cs`) |
| `sw.js` | Offline-Speicher für die App-Dateien |
| `manifest.webmanifest`, `icons/` | Home-Bildschirm-App |
