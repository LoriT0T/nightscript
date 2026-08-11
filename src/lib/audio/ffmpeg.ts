import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) =>
      reject(new Error(`${bin} could not be started (${e.message}). Is ffmpeg installed?`)),
    );
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

export const ffmpeg = (args: string[]) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args]);
export const ffprobe = (args: string[]) => run(FFPROBE, ['-hide_banner', ...args]);

export async function durationOf(path: string): Promise<number> {
  const { stdout } = await ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    path,
  ]);
  return Number(stdout.trim());
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ['-version']);
    return true;
  } catch {
    return false;
  }
}
