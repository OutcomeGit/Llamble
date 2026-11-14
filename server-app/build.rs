// Gives LlambleServer.exe its icon and file details on Windows.
fn main() {
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icon.ico");
        res.set("FileDescription", "Llamble Server");
        res.set("ProductName", "Llamble Server");
        res.set("CompanyName", "eE Planet");
        res.compile().expect("couldn't add the icon");
    }
}
