import {randomUUID} from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import {
  jobRecordSchema,
  stepRecordSchema,
  type JobRecord,
  type StepRecord,
  type StepState,
} from "@travel-movie/schema";

import type {StorageAdapter} from "../storage/storage-adapter.js";
import {hashStepParams, makeStepCacheKey} from "./cache-key.js";
import {JobEventBroker} from "./events.js";

export interface StepProgressUpdate {
  readonly etaSec?: number | null;
  readonly message?: string | null;
  readonly progress: number;
}

export interface StepContext {
  readonly jobId: string;
  readonly projectId: string;
  readonly signal: AbortSignal;
  report(update: StepProgressUpdate): void;
  /**
   * 단계가 끝나면 지워야 할 중간 파일만 등록한다.
   * 성공했을 때도 지우므로 남겨야 하는 산출물은 절대 등록하지 않는다.
   */
  trackPartialOutput(key: string): void;
}

export interface Step {
  readonly codeVersion: number;
  readonly invalidates: readonly string[];
  readonly name: string;
  outputRef?(output: unknown): string | null;
  restoreCached?(output: unknown): Promise<void>;
  run(context: StepContext, params: unknown): Promise<unknown>;
}

export interface PipelineStepRequest {
  /**
   * 앞 단계의 결과에 따라 달라지는 입력은 함수로 넘긴다.
   * 그래야 하나의 job 안에서 이어지는 단계도 캐시 키를 정확히 계산할 수 있다.
   */
  readonly inputHash: string | (() => Promise<string>);
  readonly params: unknown;
  readonly step: Step;
}

export interface RunPipelineOptions {
  readonly force?: boolean;
  readonly jobId?: string;
  readonly projectId: string;
  readonly steps: readonly PipelineStepRequest[];
}

export interface RunPipelineResult {
  readonly jobId: string;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly state: "succeeded";
}

interface ActiveJob {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
  readonly partialKeys: Set<string>;
  readonly projectId: string;
}

interface CacheRow {
  readonly output_json: string;
  readonly output_ref: string | null;
}

interface JobRow {
  readonly created_at: string;
  readonly current_step: string | null;
  readonly error: string | null;
  readonly id: string;
  readonly project_id: string;
  readonly state: JobRecord["state"];
  readonly updated_at: string;
}

interface StepRow {
  readonly cache_key: string;
  readonly code_version: number;
  readonly error: string | null;
  readonly finished_at: string | null;
  readonly input_hash: string;
  readonly job_id: string;
  readonly message: string | null;
  readonly output_ref: string | null;
  readonly params_hash: string;
  readonly progress: number;
  readonly started_at: string | null;
  readonly state: StepState;
  readonly step_name: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const placeholders = (count: number): string => Array.from({length: count}, () => "?").join(", ");

export class JobRunner {
  readonly #activeJobs = new Map<string, ActiveJob>();
  readonly #database: BetterSqlite3.Database;
  readonly #events: JobEventBroker;
  readonly #storage: StorageAdapter;

  constructor(
    database: BetterSqlite3.Database,
    storage: StorageAdapter,
    events = new JobEventBroker(),
  ) {
    this.#database = database;
    this.#storage = storage;
    this.#events = events;
  }

  get events(): JobEventBroker {
    return this.#events;
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
      JobRow | undefined;
    return row === undefined
      ? null
      : jobRecordSchema.parse({
          createdAt: row.created_at,
          currentStep: row.current_step,
          error: row.error,
          id: row.id,
          projectId: row.project_id,
          schemaVersion: 2,
          state: row.state,
          updatedAt: row.updated_at,
        });
  }

  getSteps(jobId: string): StepRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM steps WHERE job_id = ? ORDER BY rowid")
      .all(jobId) as StepRow[];
    return rows.map((row) =>
      stepRecordSchema.parse({
        cacheKey: row.cache_key,
        codeVersion: row.code_version,
        error: row.error,
        finishedAt: row.finished_at,
        inputHash: row.input_hash,
        jobId: row.job_id,
        message: row.message,
        outputRef: row.output_ref,
        paramsHash: row.params_hash,
        progress: row.progress,
        schemaVersion: 2,
        startedAt: row.started_at,
        state: row.state,
        stepName: row.step_name,
      }),
    );
  }

  runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
    if (options.projectId.length === 0) {
      throw new Error("projectId is required");
    }
    const names = options.steps.map(({step}) => step.name);
    if (new Set(names).size !== names.length) {
      throw new Error("A pipeline cannot contain the same step more than once");
    }
    for (const {inputHash, step} of options.steps) {
      if (typeof inputHash === "string" && inputHash.length === 0) {
        throw new Error(`Step ${step.name} requires a nonempty inputHash`);
      }
      if (!Number.isInteger(step.codeVersion) || step.codeVersion <= 0 || step.name.length === 0) {
        throw new Error("Step name and positive integer codeVersion are required");
      }
    }

    const jobId = options.jobId ?? `j_${randomUUID().replaceAll("-", "")}`;
    if (this.#activeJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`);
    }
    for (const active of this.#activeJobs.values()) {
      if (active.projectId === options.projectId) {
        throw new Error(`Project ${options.projectId} already has a running job`);
      }
    }
    const activeRow = this.#database
      .prepare(
        "SELECT id FROM jobs WHERE project_id = ? AND state IN ('queued', 'running') LIMIT 1",
      )
      .get(options.projectId) as {id: string} | undefined;
    if (activeRow !== undefined) {
      throw new Error(`Project ${options.projectId} already has a running job ${activeRow.id}`);
    }
    const existing = this.getJob(jobId);
    if (existing !== null && existing.projectId !== options.projectId) {
      throw new Error(`Job ${jobId} belongs to a different project`);
    }
    const now = new Date().toISOString();
    if (existing === null) {
      this.#database
        .prepare(
          `INSERT INTO jobs (id, project_id, state, current_step, error, created_at, updated_at)
           VALUES (?, ?, 'queued', NULL, NULL, ?, ?)`,
        )
        .run(jobId, options.projectId, now, now);
    } else {
      this.#database
        .prepare(
          "UPDATE jobs SET state = 'queued', current_step = NULL, error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, jobId);
    }

    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveJob = {
      controller: new AbortController(),
      done,
      finish,
      partialKeys: new Set<string>(),
      projectId: options.projectId,
    };
    this.#activeJobs.set(jobId, active);
    const outputs: Record<string, unknown> = {};

    const execution = (async (): Promise<RunPipelineResult> => {
      try {
        for (const request of options.steps) {
          if (active.controller.signal.aborted) {
            throw active.controller.signal.reason ?? new Error("Job was cancelled");
          }
          outputs[request.step.name] = await this.#runStep(
            jobId,
            options.projectId,
            request,
            active,
            options.force === true,
          );
        }

        const finishedAt = new Date().toISOString();
        this.#database
          .prepare(
            "UPDATE jobs SET state = 'succeeded', current_step = NULL, error = NULL, updated_at = ? WHERE id = ?",
          )
          .run(finishedAt, jobId);
        return {jobId, outputs, state: "succeeded"};
      } catch (error) {
        const cancelled = active.controller.signal.aborted;
        const currentStep = this.getJob(jobId)?.currentStep ?? null;
        let finalError = error;
        try {
          await this.#cleanupPartialOutputs(active);
        } catch (cleanupError) {
          finalError = new Error(
            `${errorMessage(error)}; partial output cleanup failed: ${errorMessage(cleanupError)}`,
          );
        }
        const failedAt = new Date().toISOString();
        const state = cancelled ? "cancelled" : "failed";
        this.#database
          .prepare(
            "UPDATE jobs SET state = ?, current_step = NULL, error = ?, updated_at = ? WHERE id = ?",
          )
          .run(state, errorMessage(finalError), failedAt, jobId);
        this.#database
          .prepare(
            "UPDATE steps SET state = ?, finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'",
          )
          .run(state, failedAt, errorMessage(finalError), jobId);
        if (currentStep !== null) {
          this.#events.publish(options.projectId, {
            etaSec: null,
            message: errorMessage(finalError),
            progress: 0,
            state,
            step: currentStep,
          });
        }
        throw finalError;
      } finally {
        active.finish();
        this.#activeJobs.delete(jobId);
      }
    })();

    return execution;
  }

  /** 화면의 "중지" 버튼용. 이 프로젝트에서 돌고 있는 작업을 모두 멈춘다. */
  async cancelProjectJobs(projectId: string): Promise<number> {
    const targets = [...this.#activeJobs.entries()].filter(
      ([, active]) => active.projectId === projectId,
    );
    for (const [, active] of targets) {
      active.controller.abort(new Error("사용자가 작업을 중지했습니다."));
    }
    await Promise.all(targets.map(([, active]) => active.done));
    return targets.length;
  }

  async cancel(jobId: string): Promise<boolean> {
    const active = this.#activeJobs.get(jobId);
    if (active === undefined) {
      return false;
    }
    active.controller.abort(new Error(`Job ${jobId} was cancelled`));
    await active.done;
    return true;
  }

  invalidateForProjectDocument(projectId: string): void {
    this.invalidateSteps(projectId, [
      "subtitle",
      "music",
      "timeline",
      "render",
      "finalize",
      "verify",
    ]);
  }

  invalidateForMusic(projectId: string): void {
    this.invalidateSteps(projectId, ["finalize", "verify"]);
  }

  invalidateSteps(projectId: string, stepNames: readonly string[]): void {
    const uniqueNames = [...new Set(stepNames)];
    if (uniqueNames.length === 0) {
      return;
    }
    const inClause = placeholders(uniqueNames.length);
    const invalidate = this.#database.transaction(() => {
      this.#database
        .prepare(`DELETE FROM cache WHERE project_id = ? AND step_name IN (${inClause})`)
        .run(projectId, ...uniqueNames);
      this.#database
        .prepare(
          `UPDATE steps
           SET state = 'invalidated', progress = 0, message = 'invalidated', error = NULL
           WHERE step_name IN (${inClause})
             AND job_id IN (SELECT id FROM jobs WHERE project_id = ?)
             AND state IN ('succeeded', 'cached')`,
        )
        .run(...uniqueNames, projectId);
    });
    invalidate();
    for (const step of uniqueNames) {
      this.#events.publish(projectId, {
        etaSec: null,
        message: "invalidated",
        progress: 0,
        state: "invalidated",
        step,
      });
    }
  }

  async #runStep(
    jobId: string,
    projectId: string,
    request: PipelineStepRequest,
    active: ActiveJob,
    force: boolean,
  ): Promise<unknown> {
    const {params, step} = request;
    const inputHash =
      typeof request.inputHash === "string" ? request.inputHash : await request.inputHash();
    if (inputHash.length === 0) {
      throw new Error(`Step ${step.name} requires a nonempty inputHash`);
    }
    const paramsHash = hashStepParams(params);
    const cacheKey = makeStepCacheKey(step.name, step.codeVersion, inputHash, params);
    const cached = force
      ? undefined
      : (this.#database
          .prepare(
            "SELECT output_json, output_ref FROM cache WHERE cache_key = ? AND project_id = ? AND step_name = ?",
          )
          .get(cacheKey, projectId, step.name) as CacheRow | undefined);
    if (cached !== undefined) {
      try {
        const output = JSON.parse(cached.output_json) as unknown;
        await step.restoreCached?.(output);
        if (step.restoreCached !== undefined) {
          this.invalidateSteps(projectId, step.invalidates);
        }
        const timestamp = new Date().toISOString();
        this.#upsertStep({
          cacheKey,
          codeVersion: step.codeVersion,
          error: null,
          finishedAt: timestamp,
          inputHash,
          jobId,
          message: "cache hit",
          outputRef: cached.output_ref,
          paramsHash,
          progress: 1,
          startedAt: timestamp,
          state: "cached",
          stepName: step.name,
        });
        this.#events.publish(projectId, {
          etaSec: 0,
          message: "cache hit",
          progress: 1,
          state: "cached",
          step: step.name,
        });
        return output;
      } catch {
        this.#database.prepare("DELETE FROM cache WHERE cache_key = ?").run(cacheKey);
      }
    }

    const startedAt = new Date().toISOString();
    this.#database
      .prepare(
        "UPDATE jobs SET state = 'running', current_step = ?, error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(step.name, startedAt, jobId);
    this.#upsertStep({
      cacheKey,
      codeVersion: step.codeVersion,
      error: null,
      finishedAt: null,
      inputHash,
      jobId,
      message: "running",
      outputRef: null,
      paramsHash,
      progress: 0,
      startedAt,
      state: "running",
      stepName: step.name,
    });
    this.#events.publish(projectId, {
      etaSec: null,
      message: "running",
      progress: 0,
      state: "running",
      step: step.name,
    });

    const context: StepContext = {
      jobId,
      projectId,
      report: ({etaSec = null, message = null, progress}) => {
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
          throw new RangeError("Step progress must be between 0 and 1");
        }
        this.#database
          .prepare("UPDATE steps SET progress = ?, message = ? WHERE job_id = ? AND step_name = ?")
          .run(progress, message, jobId, step.name);
        this.#events.publish(projectId, {
          etaSec,
          message,
          progress,
          state: "running",
          step: step.name,
        });
      },
      signal: active.controller.signal,
      trackPartialOutput: (key) => active.partialKeys.add(key),
    };

    const output = await step.run(context, params);
    if (active.controller.signal.aborted) {
      throw active.controller.signal.reason ?? new Error("Job was cancelled");
    }
    const outputJson = JSON.stringify(output);
    if (outputJson === undefined) {
      throw new Error(`Step ${step.name} returned a non-serializable output`);
    }
    const outputRef = step.outputRef?.(output) ?? null;
    const finishedAt = new Date().toISOString();
    const persist = this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO cache (cache_key, project_id, step_name, output_ref, output_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             project_id = excluded.project_id,
             step_name = excluded.step_name,
             output_ref = excluded.output_ref,
             output_json = excluded.output_json,
             created_at = excluded.created_at`,
        )
        .run(cacheKey, projectId, step.name, outputRef, outputJson, finishedAt);
      this.#upsertStep({
        cacheKey,
        codeVersion: step.codeVersion,
        error: null,
        finishedAt,
        inputHash,
        jobId,
        message: "succeeded",
        outputRef,
        paramsHash,
        progress: 1,
        startedAt,
        state: "succeeded",
        stepName: step.name,
      });
    });
    persist();
    await this.#cleanupPartialOutputs(active);
    this.invalidateSteps(projectId, step.invalidates);
    this.#events.publish(projectId, {
      etaSec: 0,
      message: "succeeded",
      progress: 1,
      state: "succeeded",
      step: step.name,
    });
    return output;
  }

  #upsertStep(record: Omit<StepRecord, "schemaVersion">): void {
    this.#database
      .prepare(
        `INSERT INTO steps (
           job_id, step_name, cache_key, code_version, input_hash, params_hash,
           state, started_at, finished_at, progress, message, error, output_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, step_name) DO UPDATE SET
           cache_key = excluded.cache_key,
           code_version = excluded.code_version,
           input_hash = excluded.input_hash,
           params_hash = excluded.params_hash,
           state = excluded.state,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           progress = excluded.progress,
           message = excluded.message,
           error = excluded.error,
           output_ref = excluded.output_ref`,
      )
      .run(
        record.jobId,
        record.stepName,
        record.cacheKey,
        record.codeVersion,
        record.inputHash,
        record.paramsHash,
        record.state,
        record.startedAt,
        record.finishedAt,
        record.progress,
        record.message,
        record.error,
        record.outputRef,
      );
  }

  async #cleanupPartialOutputs(active: ActiveJob): Promise<void> {
    const keys = [...active.partialKeys];
    active.partialKeys.clear();
    await Promise.all(keys.map((key) => this.#storage.delete(key)));
  }
}
