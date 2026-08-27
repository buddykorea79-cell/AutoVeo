import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";

export class FilePickerUnavailableError extends Error {}

export interface FilePicker {
  /** initialPath는 창이 처음 보여줄 폴더. 없으면 OS 기본값을 쓴다. */
  selectFile(initialPath?: string, filterDescription?: string): Promise<string | null>;
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

export const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const WINDOWS_FILE_DIALOG_SOURCE = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = "MP3 files (*.mp3)|*.mp3|All files (*.*)|*.*"
$dialog.Title = "MP3 음악 파일 선택"
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
`.trim();

const buildWindowsFilePickerScript = (initialPath: string | null): string => {
  const initDir =
    initialPath === null
      ? ""
      : `$dialog.InitialDirectory = ${powerShellLiteral(path.dirname(initialPath))}\n$dialog.FileName = ${powerShellLiteral(path.basename(initialPath))}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    WINDOWS_FILE_DIALOG_SOURCE,
    initDir,
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
  ]
    .filter(Boolean)
    .join("\n");
};

const selectWindowsFile = async (initialPath: string | null): Promise<string | null> => {
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      buildWindowsFilePickerScript(initialPath),
    ],
    false,
  );
  if (result.exitCode !== 0) {
    throw new FilePickerUnavailableError(result.stderr.trim() || "Windows file picker failed");
  }
  return result.stdout.trim() || null;
};

const selectMacFile = async (initialPath: string | null): Promise<string | null> => {
  const prompt = "MP3 음악 파일을 선택하세요.";
  const script =
    initialPath === null
      ? `POSIX path of (choose file with prompt "${prompt}" of type {"mp3"})`
      : `POSIX path of (choose file with prompt "${prompt}" default location POSIX file ${JSON.stringify(initialPath)} of type {"mp3"})`;
  const result = await run("osascript", ["-e", script]);
  if (result.exitCode === 0) {
    return result.stdout.trim() || null;
  }
  if (result.stderr.toLowerCase().includes("cancel") || result.stderr.includes("-128")) {
    return null;
  }
  throw new FilePickerUnavailableError(result.stderr.trim() || "macOS file picker failed");
};

const selectLinuxFile = async (initialPath: string | null): Promise<string | null> => {
  const baseArgs = [
    "--file-selection",
    "--title=MP3 음악 파일 선택",
    "--file-filter=MP3 files | *.mp3",
  ];
  for (const [executable, args] of [
    ["zenity", initialPath === null ? baseArgs : [...baseArgs, `--filename=${initialPath}`]],
    ["kdialog", ["--getopenfilename", initialPath ?? ".", "*.mp3 | MP3 files"]],
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
  throw new FilePickerUnavailableError("zenity 또는 kdialog를 사용할 수 없습니다.");
};

export const localFilePicker: FilePicker = {
  selectFile: (initialPath?: string) => {
    const start = initialPath === undefined || initialPath.length === 0 ? null : initialPath;
    if (process.platform === "win32") {
      return selectWindowsFile(start);
    }
    if (process.platform === "darwin") {
      return selectMacFile(start);
    }
    return selectLinuxFile(start);
  },
};
