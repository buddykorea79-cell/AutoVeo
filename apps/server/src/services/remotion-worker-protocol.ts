export interface RemotionWorkerRequest {
  readonly browserExecutable: string | null;
  readonly compositionId: string;
  readonly concurrency: number;
  readonly entryPoint: string;
  readonly outputLocation: string;
  readonly planPath: string;
  readonly publicDir: string;
  readonly workDirectory: string;
}

export interface RemotionWorkerMessage {
  readonly progress: number;
  readonly type: "progress";
}
