#!/usr/bin/env node
/**
 * ASR Transcribe — 火山引擎豆包 ASR 大模型转写脚本 (Seed ASR)
 *
 * Usage:
 *   npx tsx src/index.ts --file <audio_path> --output <output_dir> --title <title>
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

/* ------------------------------------------------------------------ */
/*  CLI args                                                           */
/* ------------------------------------------------------------------ */
const args = process.argv.slice(2);
function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) {
    console.error(`Missing required argument: --${name}`);
    process.exit(1);
  }
  return args[idx + 1];
}

function getOptionalArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const audioFile = getArg('file');
const outputDir = getArg('output');
const title = getArg('title');
const providedAudioUrl = getOptionalArg('url');

const API_KEY = process.env.VOLC_ASR_API_KEY;
const APP_KEY = process.env.VOLC_ASR_APP_KEY;
const ACCESS_KEY = process.env.VOLC_ASR_ACCESS_KEY;
const RESOURCE_ID = process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.auc';
if (!API_KEY && !(APP_KEY && ACCESS_KEY)) {
  console.error('Missing VOLC_ASR_API_KEY or VOLC_ASR_APP_KEY/VOLC_ASR_ACCESS_KEY environment variables');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function log(msg: string) {
  process.stderr.write(`[asr] ${msg}\n`);
}

function authHeaders(): Record<string, string> {
  if (API_KEY) return { 'x-api-key': API_KEY };
  return {
    'X-Api-App-Key': APP_KEY!,
    'X-Api-Access-Key': ACCESS_KEY!,
  };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function jsonPost(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') respHeaders[k] = v;
          }
          try {
            resolve({ status: res.statusCode ?? 0, headers: respHeaders, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, headers: respHeaders, data: text });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Step 1: Upload audio to tmpfiles.org for a temporary public URL   */
/* ------------------------------------------------------------------ */
async function uploadToTmpFiles(filePath: string): Promise<string> {
  log('Uploading audio to temporary file hosting...');
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'tmpfiles.org',
        path: '/api/v1/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const resp = JSON.parse(Buffer.concat(chunks).toString());
            if (resp.data?.url) {
              const dlUrl = resp.data.url.replace(
                'tmpfiles.org/',
                'tmpfiles.org/dl/',
              );
              log(`Upload OK: ${dlUrl}`);
              resolve(dlUrl);
            } else {
              reject(new Error(`Upload failed: ${JSON.stringify(resp)}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Step 2: Volcengine BigModel ASR (Seed ASR)                        */
/* ------------------------------------------------------------------ */
const VOLC_SUBMIT_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
const VOLC_QUERY_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';

// Status codes from X-Api-Status-Code header
const STATUS_DONE = '20000000';
const STATUS_QUEUED = '20000001';
const STATUS_PROCESSING = '20000002';

interface Utterance {
  text: string;
  start_time: number;
  end_time: number;
  additions?: {
    speaker?: string;
    channel_id?: string;
  };
  words?: Array<{
    text: string;
    start_time: number;
    end_time: number;
  }>;
}

interface QueryResult {
  audio_info?: { duration: number };
  result?: {
    text?: string;
    utterances?: Utterance[];
  };
}

function getExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const map: Record<string, string> = {
    m4a: 'm4a', mp3: 'mp3', wav: 'wav', ogg: 'ogg',
    flac: 'flac', aac: 'aac', amr: 'amr', mp4: 'mp4',
  };
  return map[ext] || 'mp3';
}

async function submitJob(audioUrl: string): Promise<string> {
  log('Submitting ASR job to Volcengine BigModel...');
  const requestId = crypto.randomUUID();

  const resp = await jsonPost(
    VOLC_SUBMIT_URL,
    {
      user: { uid: 'happyclaw' },
      audio: {
        url: audioUrl,
        format: getExtension(audioFile),
        codec: 'raw',
        language: 'zh-CN',
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        enable_speaker_info: true,
      },
    },
    {
      ...authHeaders(),
      'X-Api-Resource-Id': RESOURCE_ID,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    },
  );

  const statusCode = resp.headers['x-api-status-code'] || '';
  log(`Submit response: HTTP ${resp.status}, X-Api-Status-Code=${statusCode}`);
  log(`Response body: ${JSON.stringify(resp.data).slice(0, 500)}`);

  if (resp.status >= 400) {
    throw new Error(`ASR submit failed: HTTP ${resp.status} - ${JSON.stringify(resp.data)}`);
  }

  log(`Job submitted, request_id=${requestId}`);
  return requestId;
}

async function pollResult(requestId: string): Promise<{ utterances: Utterance[]; fullText: string; duration: number }> {
  const maxAttempts = 120; // 10 minutes
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await jsonPost(
      VOLC_QUERY_URL,
      {},
      {
        ...authHeaders(),
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Request-Id': requestId,
      },
    );

    const statusCode = resp.headers['x-api-status-code'] || '';

    if (statusCode === STATUS_QUEUED || statusCode === STATUS_PROCESSING) {
      if (i % 6 === 0) log(`Waiting... (${i * 5}s elapsed, status=${statusCode})`);
      await sleep(5000);
      continue;
    }

    if (statusCode === STATUS_DONE) {
      const body = resp.data as QueryResult;
      const utterances = body.result?.utterances || [];
      const fullText = body.result?.text || '';
      const duration = body.audio_info?.duration || 0;
      log(`ASR complete! ${utterances.length} utterances, ${Math.ceil(duration / 1000)}s audio`);
      return { utterances, fullText, duration };
    }

    // Unknown status — log and continue
    if (i % 6 === 0) {
      log(`Status=${statusCode}, body=${JSON.stringify(resp.data).slice(0, 200)}`);
    }

    // If status starts with 4 or 5, it's an error
    if (statusCode.startsWith('4') || statusCode.startsWith('5')) {
      throw new Error(`ASR error: status=${statusCode}, body=${JSON.stringify(resp.data)}`);
    }

    await sleep(5000);
  }
  throw new Error('ASR polling timed out after 10 minutes');
}

/* ------------------------------------------------------------------ */
/*  Step 3: Generate Markdown                                         */
/* ------------------------------------------------------------------ */
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function generateMarkdown(
  utterances: Utterance[],
  fullText: string,
  durationMs: number,
  titleStr: string,
): { markdown: string; stats: Record<string, unknown> } {
  const speakers = new Set<string>();
  let totalChars = 0;

  for (const u of utterances) {
    const spk = u.additions?.speaker || '0';
    speakers.add(spk);
    totalChars += u.text.length;
  }

  const durationMin = Math.ceil(durationMs / 60000);
  const speakerCount = Math.max(speakers.size, 1);

  let md = `# ${titleStr}\n\n`;
  md += `- **日期**：${new Date().toISOString().slice(0, 10)}\n`;
  md += `- **时长**：约 ${durationMin} 分钟\n`;
  md += `- **说话人数**：${speakerCount}\n`;
  md += `- **总字数**：${totalChars}\n`;
  md += `- **语句数**：${utterances.length}\n\n`;
  md += `---\n\n`;
  md += `## 转写内容\n\n`;

  let lastSpeaker = '';
  for (const u of utterances) {
    const spk = u.additions?.speaker || '0';
    const spkLabel = `说话人 ${parseInt(spk) + 1}`;
    const timeStr = formatTime(u.start_time);
    if (spk !== lastSpeaker) {
      md += `\n### ${spkLabel} (${timeStr})\n\n`;
      lastSpeaker = spk;
    }
    md += `[${timeStr}] ${u.text}\n\n`;
  }

  const stats = {
    title: titleStr,
    duration_minutes: durationMin,
    speaker_count: speakerCount,
    utterance_count: utterances.length,
    total_chars: totalChars,
  };

  return { markdown: md, stats };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  if (!fs.existsSync(audioFile)) {
    console.error(`Audio file not found: ${audioFile}`);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // Upload, unless a public URL is provided by the caller.
  const audioUrl = providedAudioUrl || await uploadToTmpFiles(audioFile);

  // Submit & poll
  const requestId = await submitJob(audioUrl);
  const { utterances, fullText, duration } = await pollResult(requestId);

  // Generate markdown
  const { markdown, stats } = generateMarkdown(utterances, fullText, duration, title);

  // Write output
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_');
  const outputPath = path.join(outputDir, `${safeTitle}.md`);
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  log(`Markdown saved to: ${outputPath}`);

  // Output JSON stats to stdout
  console.log(
    JSON.stringify({ ...stats, output_path: outputPath }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
