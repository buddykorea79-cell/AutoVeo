import {spawn} from "node:child_process";
import process from "node:process";

export class FolderPickerUnavailableError extends Error {}

export interface FolderPicker {
  /** initialPath 는 창이 처음 보여줄 폴더다. 없으면 OS 기본값을 쓴다. */
  selectFolder(initialPath?: string): Promise<string | null>;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const run = (
  executable: string,
  args: readonly string[],
  windowsHide = true,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {shell: false, windowsHide});
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({exitCode, stderr, stdout}));
  });

/**
 * PowerShell 리터럴 안에 넣을 문자열. 작은따옴표만 두 번으로 바꾸면 된다.
 * 경로에 따옴표나 세미콜론이 들어 있어도 스크립트가 깨지지 않는다.
 */
export const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Windows 폴더 선택은 IFileOpenDialog(FOS_PICKFOLDERS)로 연다.
 * - 옛 FolderBrowserDialog 의 좁은 트리 대신 탐색기와 같은 창이 열린다.
 * - 브라우저 창(GetForegroundWindow)을 소유자로 넘기고, 별도 스레드로 한 번 더 앞에 세운다.
 * - SetFolder 로 시작 폴더를 지정한다.
 *
 * COM 호출을 PowerShell 에서 직접 하면 __ComObject 로 풀려 인터페이스 메서드를 잃는다.
 * 그래서 대화 전체를 C# 정적 메서드 안에서 끝내고 결과 경로만 돌려받는다.
 */
const WINDOWS_DIALOG_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "using System.Threading;",
  "namespace AutoVeo {",
  '  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IFileOpenDialog {",
  "    [PreserveSig] int Show(IntPtr parent);",
  "    void SetFileTypes(uint count, IntPtr filters);",
  "    void SetFileTypeIndex(uint index);",
  "    void GetFileTypeIndex(out uint index);",
  "    void Advise(IntPtr sink, out uint cookie);",
  "    void Unadvise(uint cookie);",
  "    void SetOptions(uint options);",
  "    void GetOptions(out uint options);",
  "    void SetDefaultFolder(IShellItem item);",
  "    void SetFolder(IShellItem item);",
  "    void GetFolder(out IShellItem item);",
  "    void GetCurrentSelection(out IShellItem item);",
  "    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);",
  "    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);",
  "    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);",
  "    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);",
  "    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);",
  "    void GetResult(out IShellItem item);",
  "    void AddPlace(IShellItem item, int place);",
  "    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);",
  "    void Close(int result);",
  "    void SetClientGuid(ref Guid guid);",
  "    void ClearClientData();",
  "    void SetFilter(IntPtr filter);",
  "  }",
  '  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IShellItem {",
  "    void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);",
  "    void GetParent(out IShellItem parent);",
  "    void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string value);",
  "    void GetAttributes(uint mask, out uint attributes);",
  "    void Compare(IShellItem other, uint hint, out int order);",
  "  }",
  "  public static class FolderPicker {",
  // FOS_NOCHANGEDIR | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
  "    const uint OPTIONS = 0x868;",
  "    const int CANCELLED = unchecked((int) 0x800704C7);",
  "    const uint FILESYSTEM_PATH = 0x80058000;",
  '    static readonly Guid SHELL_ITEM = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");',
  '    static readonly Guid DIALOG_CLSID = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");',
  '    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]',
  "    static extern IShellItem SHCreateItemFromParsingName(",
  "      [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bc,",
  "      [MarshalAs(UnmanagedType.LPStruct)] Guid riid);",
  '    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);',
  '    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);',
  '    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);',
  '    [DllImport("user32.dll")] static extern bool SetWindowPos(',
  "      IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);",
  '    [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  "    static extern int GetClassNameW(IntPtr window, StringBuilder text, int max);",
  '    [DllImport("user32.dll")]',
  "    static extern bool EnumThreadWindows(uint threadId, EnumWindowsProc callback, IntPtr data);",
  '    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  "    delegate bool EnumWindowsProc(IntPtr window, IntPtr data);",
  "    static IntPtr found = IntPtr.Zero;",
  "    static bool Inspect(IntPtr window, IntPtr data) {",
  "      StringBuilder name = new StringBuilder(64);",
  "      GetClassNameW(window, name, name.Capacity);",
  // 공용 대화 상자의 창 클래스는 항상 #32770 이다.
  '      if (name.ToString() == "#32770" && IsWindowVisible(window)) {',
  "        found = window;",
  "        return false;",
  "      }",
  "      return true;",
  "    }",
  /*
   * Show 는 호출한 스레드를 막는다. 그래서 대화 상자가 뜬 직후 그것을 찾아
   * 앞으로 끌어올리는 일은 별도 스레드에서 한다.
   * 소유자 창을 못 찾은 경우(브라우저가 포커스를 잃은 경우)에도 창이 뒤로 숨지 않는다.
   */
  "    static void ForceToFront(uint dialogThreadId) {",
  "      for (int attempt = 0; attempt < 50; attempt++) {",
  "        Thread.Sleep(100);",
  "        found = IntPtr.Zero;",
  "        try { EnumThreadWindows(dialogThreadId, Inspect, IntPtr.Zero); }",
  "        catch (Exception) { return; }",
  "        if (found == IntPtr.Zero) { continue; }",
  // HWND_TOPMOST 로 올렸다가 곧바로 내리면 포커스 제한과 무관하게 맨 앞에 선다.
  "        SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0003);",
  "        SetWindowPos(found, new IntPtr(-2), 0, 0, 0, 0, 0x0003);",
  "        BringWindowToTop(found);",
  "        SetForegroundWindow(found);",
  "        return;",
  "      }",
  "    }",
  "    public static string Pick(string initialPath) {",
  "      IFileOpenDialog dialog =",
  "        (IFileOpenDialog) Activator.CreateInstance(Type.GetTypeFromCLSID(DIALOG_CLSID));",
  "      try {",
  "        dialog.SetOptions(OPTIONS);",
  '        dialog.SetTitle("여행 사진과 동영상이 있는 폴더 선택");',
  '        dialog.SetOkButtonLabel("이 폴더 사용");',
  "        if (!String.IsNullOrEmpty(initialPath)) {",
  "          try {",
  "            dialog.SetFolder(SHCreateItemFromParsingName(initialPath, IntPtr.Zero, SHELL_ITEM));",
  "          } catch (Exception) { }",
  "        }",
  "        uint dialogThreadId = GetCurrentThreadId();",
  "        Thread lifter = new Thread(delegate() { ForceToFront(dialogThreadId); });",
  "        lifter.IsBackground = true;",
  "        lifter.Start();",
  "        int result = dialog.Show(GetForegroundWindow());",
  "        if (result == CANCELLED) { return null; }",
  '        if (result != 0) { throw new COMException("folder dialog failed", result); }',
  "        IShellItem item;",
  "        dialog.GetResult(out item);",
  "        string selected;",
  "        item.GetDisplayName(FILESYSTEM_PATH, out selected);",
  "        return selected;",
  "      } finally {",
  "        Marshal.ReleaseComObject(dialog);",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

export const buildWindowsPickerScript = (initialPath: string | null): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    WINDOWS_DIALOG_SOURCE,
    "'@",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$picked = [AutoVeo.FolderPicker]::Pick(${
      initialPath === null ? "$null" : powerShellLiteral(initialPath)
    })`,
    "if ($picked -ne $null) { [Console]::Out.Write($picked) }",
  ].join("\n");

const selectWindowsFolder = async (initialPath: string | null): Promise<string | null> => {
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", buildWindowsPickerScript(initialPath)],
    false,
  );
  if (result.exitCode !== 0) {
    throw new FolderPickerUnavailableError(result.stderr.trim() || "Windows folder picker failed");
  }
  return result.stdout.trim() || null;
};

const selectMacFolder = async (initialPath: string | null): Promise<string | null> => {
  const prompt = "여행 사진과 동영상이 있는 폴더를 선택하세요.";
  const script =
    initialPath === null
      ? `POSIX path of (choose folder with prompt "${prompt}")`
      : `POSIX path of (choose folder with prompt "${prompt}" default location POSIX file ${JSON.stringify(
          initialPath,
        )})`;
  const result = await run("osascript", ["-e", script]);
  if (result.exitCode === 0) {
    return result.stdout.trim().replace(/\/$/u, "") || null;
  }
  if (result.stderr.toLowerCase().includes("cancel")) {
    return null;
  }
  throw new FolderPickerUnavailableError(result.stderr.trim() || "macOS folder picker failed");
};

const selectLinuxFolder = async (initialPath: string | null): Promise<string | null> => {
  const zenityArgs = ["--file-selection", "--directory", "--title=여행 폴더 선택"];
  for (const [executable, args] of [
    ["zenity", initialPath === null ? zenityArgs : [...zenityArgs, `--filename=${initialPath}/`]],
    ["kdialog", ["--getexistingdirectory", initialPath ?? ".", "--title", "여행 폴더 선택"]],
  ] as const) {
    try {
      const result = await run(executable, args);
      if (result.exitCode === 0) {
        return result.stdout.trim() || null;
      }
      if (result.exitCode === 1) {
        return null;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new FolderPickerUnavailableError("zenity 또는 kdialog를 사용할 수 없습니다.");
};

export const localFolderPicker: FolderPicker = {
  selectFolder: (initialPath?: string) => {
    const start = initialPath === undefined || initialPath.length === 0 ? null : initialPath;
    if (process.platform === "win32") {
      return selectWindowsFolder(start);
    }
    if (process.platform === "darwin") {
      return selectMacFolder(start);
    }
    return selectLinuxFolder(start);
  },
};
