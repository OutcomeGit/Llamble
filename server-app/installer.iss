; Llamble Server for Windows installer (Inno Setup). CI builds it from the staged folder:
;   ISCC /DAppVersion=0.1.N /DStage=<folder> installer.iss   ->  Output\LlambleServer-Setup.exe
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "stage"
#endif

[Setup]
AppId={{6E1C2A57-4B1F-4C6E-9C1D-6A6B1E8F2D31}
AppName=Llamble Server
AppVersion={#AppVersion}
AppPublisher=eE Planet
AppPublisherURL=https://llamble.com
DefaultDirName={autopf}\Llamble Server
DefaultGroupName=Llamble Server
DisableProgramGroupPage=yes
; admin: it adds the firewall rules so people on your network can reach the server
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=LlambleServer-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\LlambleServer.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile={#Stage}\LICENSE.txt
CloseApplications=force

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Llamble Server"; Filename: "{app}\LlambleServer.exe"
Name: "{autodesktop}\Llamble Server"; Filename: "{app}\LlambleServer.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Put a Llamble Server icon on the desktop"; Flags: unchecked
Name: "autostart"; Description: "Start Llamble Server when Windows starts"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Llamble Server"; ValueData: """{app}\LlambleServer.exe"" --background"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
; let other PCs and phones on your network reach the server, its voice server and AI
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Llamble Server"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Llamble Server"" dir=in action=allow program=""{app}\bin\llamble-server.exe"" enable=yes profile=private,domain"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Llamble Server"" dir=in action=allow program=""{app}\livekit\livekit-server.exe"" enable=yes profile=private,domain"; Flags: runhidden
Filename: "{app}\LlambleServer.exe"; Description: "Start Llamble Server now"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM LlambleServer.exe"; Flags: runhidden; RunOnceId: "StopApp"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM llamble-server.exe"; Flags: runhidden; RunOnceId: "StopServer"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Llamble Server"""; Flags: runhidden; RunOnceId: "Firewall"

[Messages]
FinishedLabel=Llamble Server is installed. It runs in the system tray (bottom right, near the clock). The first time, it opens the setup page in your browser. Your accounts and chats are kept in %LOCALAPPDATA%\Llamble Server, and stay there if you uninstall.
