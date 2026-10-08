// W15 高 DPI 字体模糊（125%/150%）：tauri-build 默认 manifest 只有 Common-Controls 依赖、
// 无 dpiAware 声明——DPI 感知此前全靠 tao 在 EventLoop 创建时调 SetProcessDpiAwarenessContext
//（运行时层，先于任何窗口创建，理论上等效）。把 PerMonitorV2 烙进 exe manifest（静态层）
// 双保险：Explorer/安装器等先读 manifest 定 DPI 虚拟化策略的路径不再依赖运行时调用时序。
// Common-Controls v6 依赖保留（tauri-build 文档要求：dialog API 需要）；仅 Windows 生效，
// 其他平台该 manifest 不嵌入、零影响。
fn main() {
    let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10/11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
      <!-- Windows 8.1 -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
    </application>
  </compatibility>
  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>
"#;
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(manifest)),
    )
    .expect("tauri build 失败");
}
