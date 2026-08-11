import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { waveToPcm16Le } from '../server/wav';

const execFileAsync = promisify(execFile);
const ENGLISH_VOICE = 'Samantha';

export async function synthesizeWithAppleSpeech(text: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-remote-speech-'));
  const inputPath = join(directory, 'message.txt');
  const aiffPath = join(directory, 'speech.aiff');
  const wavePath = join(directory, 'speech.wav');
  try {
    await writeFile(inputPath, text, 'utf8');
    await execFileAsync('/usr/bin/say', [
      '-v', ENGLISH_VOICE,
      '-o', aiffPath,
      '-f', inputPath,
    ]);
    await execFileAsync('/usr/bin/afconvert', [
      aiffPath,
      wavePath,
      '-f', 'WAVE',
      '-d', 'LEI16@24000',
      '-c', '1',
    ]);
    return waveToPcm16Le(await readFile(wavePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
