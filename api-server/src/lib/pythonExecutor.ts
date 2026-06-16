import { spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionUpload } from "./sessionStore.js";

// ── Security: env-var denylist ──────────────────────────────────────────────
// Strip anything that looks like a secret so there is nothing to exfiltrate.
const SECRET_ENV_PATTERNS = [
  /KEY$/i, /TOKEN$/i, /SECRET$/i, /PASSWORD$/i, /PASSWD$/i,
  /CREDENTIAL/i, /API_/i, /AUTH_/i, /PRIVATE/i,
  /DATABASE_URL/i, /SUPABASE/i, /OPENAI/i, /ANTHROPIC/i,
  /REPLIT_DB/i, /REPLIT_API/i,
];
function isSecretVar(name: string): boolean {
  return SECRET_ENV_PATTERNS.some((re) => re.test(name));
}
function buildSafeEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isSecretVar(k)) safe[k] = v;
  }
  safe.MPLBACKEND = "Agg";
  safe.PYTHONDONTWRITEBYTECODE = "1";
  safe.PYTHONUNBUFFERED = "1";
  safe.OPENBLAS_NUM_THREADS = "2";
  safe.OMP_NUM_THREADS = "2";
  safe.MKL_NUM_THREADS = "2";
  return safe;
}

// ── Condition scale constants (mirrors markov.ts CONDITION_SCALES) ──────────
const CONDITION_SCALES_PY = `
# ── SAM condition scales ──────────────────────────────────────────────────
SAM_SCALES = {
    'scale_0_100': [
        {'label': 'Excellent', 'min': 81, 'max': 100, 'midpoint': 90},
        {'label': 'Good',      'min': 61, 'max': 80,  'midpoint': 70},
        {'label': 'Fair',      'min': 41, 'max': 60,  'midpoint': 50},
        {'label': 'Poor',      'min': 21, 'max': 40,  'midpoint': 30},
        {'label': 'Critical',  'min': 0,  'max': 20,  'midpoint': 10},
    ],
    'nbi_0_9': [
        {'label': 'Good', 'min': 7, 'max': 9, 'midpoint': 8.0},
        {'label': 'Fair', 'min': 5, 'max': 6, 'midpoint': 5.5},
        {'label': 'Poor', 'min': 0, 'max': 4, 'midpoint': 2.0},
    ],
    'pci_0_100': [
        {'label': 'Very Good', 'min': 85, 'max': 100, 'midpoint': 92},
        {'label': 'Good',      'min': 70, 'max': 84,  'midpoint': 77},
        {'label': 'Fair',      'min': 55, 'max': 69,  'midpoint': 62},
        {'label': 'Poor',      'min': 40, 'max': 54,  'midpoint': 47},
        {'label': 'Very Poor', 'min': 0,  'max': 39,  'midpoint': 20},
    ],
    'scale_0_10': [
        {'label': 'Excellent', 'min': 9,  'max': 10, 'midpoint': 9.5},
        {'label': 'Good',      'min': 7,  'max': 8,  'midpoint': 7.5},
        {'label': 'Fair',      'min': 5,  'max': 6,  'midpoint': 5.5},
        {'label': 'Poor',      'min': 3,  'max': 4,  'midpoint': 3.5},
        {'label': 'Critical',  'min': 0,  'max': 2,  'midpoint': 1.0},
    ],
}

def sam_condition_label(value, scale='scale_0_100'):
    """Return the condition band label for a numeric value on the given scale."""
    for s in SAM_SCALES[scale]:
        if float(value) >= s['min']:
            return s['label']
    return SAM_SCALES[scale][-1]['label']

def sam_condition_dist(series, scale='scale_0_100'):
    """
    Compute condition distribution for a pandas Series.
    Returns list of {label, count, percentage} ready for __SAM_RESULT__.
    """
    valid = series.dropna().astype(float)
    total = len(valid)
    labels = [s['label'] for s in SAM_SCALES[scale]]
    counts = {l: 0 for l in labels}
    for v in valid:
        counts[sam_condition_label(v, scale)] += 1
    return [
        {
            'label': l,
            'count': counts[l],
            'percentage': round(counts[l] / total * 100, 1) if total > 0 else 0,
        }
        for l in labels
    ]
`;

// ── Safe imports (run BEFORE the sandbox guard) ─────────────────────────────
// Load all science packages first so their internal imports (subprocess for font
// cache, urllib.parse for pandas, etc.) succeed before the guard removes them.
const SAFE_IMPORTS = `import io, json, base64, math, datetime, warnings
warnings.filterwarnings('ignore')
import pandas as pd
import numpy as np
import scipy as sp
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

# Warm up font manager NOW so matplotlib never needs subprocess after the guard.
try:
    import matplotlib.font_manager as _fmgr
    _ = _fmgr.fontManager
    del _fmgr, _
except Exception:
    pass

try:
    import statsmodels.api as sm
except ImportError:
    sm = None

try:
    import sklearn
except ImportError:
    sklearn = None
`;

// ── Hardened sandbox guard (installed AFTER safe imports) ───────────────────
// Three layers:
//   1. Patch os module to disable process-spawning primitives.
//   2. Override builtins.open to enforce filesystem boundaries.
//   3. Block network/process module imports via find_spec (Python 3.12+).
//
// _SESSION_TMPDIR is injected by buildScript() at runtime.
const SECURITY_GUARD_POSTIMPORT = `
# ── SAM sandbox (three-layer, post-import) ──────────────────────────────────
import sys as _sys, os as _os, builtins as _builtins

# ── Layer 1: patch os to disable process/env primitives ─────────────────────
def _sam_blocked_op(*a, **kw):
    raise PermissionError(
        "Process and environment operations are not available in the SAM sandbox."
    )
for _fn in [
    'system', 'popen',
    'execv', 'execve', 'execvp', 'execvpe', 'execl', 'execle', 'execlp', 'execlpe',
    'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe',
    'fork', 'forkpty',
    'putenv', 'unsetenv',
]:
    if hasattr(_os, _fn):
        setattr(_os, _fn, _sam_blocked_op)
del _fn

# ── Layer 2: restrict filesystem access ──────────────────────────────────────
# All paths are resolved with abspath() so relative traversal (../../..) is caught.
# Reads allowed from: Python nix-store, pip site-packages, session dir only.
# Writes allowed ONLY inside _SESSION_TMPDIR.
_SAFE_READ_PREFIXES = (
    '/nix/store/',
    '/home/runner/workspace/.pythonlibs/',
    _SESSION_TMPDIR,   # session data only — not all of /tmp/
    '/proc/self/',     # allow /proc/self/fd for io operations
)
_real_open = _builtins.open

def _sam_safe_open(file, mode='r', *args, **kwargs):
    # Always resolve to an absolute path so relative traversal (../../etc) is caught
    f = _os.path.abspath(str(file))
    _write = any(c in str(mode) for c in ('w', 'a', 'x'))
    if _write:
        if not f.startswith(_SESSION_TMPDIR):
            raise PermissionError(
                f"Write access outside the session sandbox is not allowed: {f!r}"
            )
    else:
        if not any(f.startswith(p) for p in _SAFE_READ_PREFIXES):
            raise PermissionError(
                f"Read access to {f!r} is not allowed in the SAM sandbox. "
                "Only session data and Python libraries may be read."
            )
    return _real_open(f, mode, *args, **kwargs)

_builtins.open = _sam_safe_open

# ── Layer 3: block dangerous module imports (find_spec, Python 3.12+) ────────
_BLOCKED_ROOTS = frozenset([
    'subprocess', 'multiprocessing',
    'socket', 'socketserver', '_socket',
    'requests', 'httpx', 'aiohttp', 'httplib2',
    'ftplib', 'smtplib', 'imaplib', 'poplib', 'telnetlib', 'nntplib',
    'xmlrpc', 'pty', 'tty', 'termios',
    'ctypes', 'cffi',
])
_BLOCKED_FULL = frozenset([
    'urllib.request', 'urllib.robotparser',
    'http.client', 'http.server',
    'xmlrpc.client', 'xmlrpc.server',
    'multiprocessing.pool', 'ctypes.cdll',
])

# Remove already-loaded network/process modules from sys.modules
for _m in list(_BLOCKED_ROOTS | _BLOCKED_FULL):
    _sys.modules.pop(_m, None)

class _BlockedImportFinder:
    def find_spec(self, name, path, target=None):
        if name in _BLOCKED_FULL or name.split('.')[0] in _BLOCKED_ROOTS:
            raise ImportError(
                f"Module '{name}' is not available in the SAM analysis sandbox. "
                "Network and process execution are disabled."
            )
        return None

_sys.meta_path.insert(0, _BlockedImportFinder())
del _BlockedImportFinder, _m
# ── End sandbox ───────────────────────────────────────────────────────────────
`;

const EXECUTION_TIMEOUT_MS = 45_000;

export interface PythonResult {
  result: unknown | null;
  charts: string[];
  config: {
    assetType?: string;
    conditionColumn?: string;
    scale?: string;
  } | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

async function getSessionDir(sessionId: string): Promise<string> {
  const dir = join(tmpdir(), "sam-sessions", sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function getDataCsvPath(sessionId: string, upload: SessionUpload): Promise<string> {
  const dir = await getSessionDir(sessionId);
  const csvPath = join(dir, "data.csv");

  const { columns, data } = upload;
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = columns.map(escape).join(",");
  const rows = data.map((row) => columns.map((c) => escape(row[c])).join(","));
  await writeFile(csvPath, [header, ...rows].join("\n"), "utf-8");
  return csvPath;
}

/**
 * Build the full Python script.
 * Injection order: safe imports → scales → sandbox guard → load df → user code
 * _SESSION_TMPDIR is injected first so the guard's filesystem check can use it.
 */
function buildScript(sessionDir: string, csvPath: string, userCode: string): string {
  const escapedDir = sessionDir.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const escapedCsv = csvPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  return `_SESSION_TMPDIR = '${escapedDir}'
${SAFE_IMPORTS}
${CONDITION_SCALES_PY}
${SECURITY_GUARD_POSTIMPORT}

df = pd.read_csv('${escapedCsv}')

# Coerce numeric-looking columns
for _col in df.columns:
    try:
        df[_col] = pd.to_numeric(df[_col], errors='ignore')
    except Exception:
        pass

# ─── user code below ──────────────────────────────────────────────────────────
${userCode}
`;
}

export async function executePython(
  sessionId: string,
  upload: SessionUpload,
  userCode: string
): Promise<PythonResult> {
  let scriptPath: string | null = null;

  try {
    const sessionDir = await getSessionDir(sessionId);
    const csvPath = await getDataCsvPath(sessionId, upload);
    const fullScript = buildScript(sessionDir, csvPath, userCode);

    scriptPath = join(sessionDir, `run-${Date.now()}.py`);
    await writeFile(scriptPath, fullScript, "utf-8");

    const result = await runScript(scriptPath, sessionDir);
    return parseOutput(result.stdout, result.stderr, result.error);
  } finally {
    if (scriptPath) {
      unlink(scriptPath).catch(() => {});
    }
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  error: string | null;
}

function runScript(scriptPath: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn("python3", [scriptPath], {
      cwd,
      env: buildSafeEnv(),
      timeout: EXECUTION_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        stdout,
        stderr: stderr + "\nExecution timed out after 45 seconds.",
        error: "Timeout",
      });
    }, EXECUTION_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const error = code !== 0 ? `Process exited with code ${code}` : null;
      resolve({ stdout, stderr, error });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: err.message });
    });
  });
}

function parseOutput(stdout: string, stderr: string, processError: string | null): PythonResult {
  const lines = stdout.split("\n");
  const otherLines: string[] = [];
  let result: unknown | null = null;
  const charts: string[] = [];
  let config: PythonResult["config"] = null;

  for (const line of lines) {
    if (line.startsWith("__SAM_RESULT__:")) {
      try {
        result = JSON.parse(line.slice("__SAM_RESULT__:".length).trim());
      } catch {
        otherLines.push(line);
      }
    } else if (line.startsWith("__SAM_CHART__:")) {
      const b64 = line.slice("__SAM_CHART__:".length).trim();
      if (b64) charts.push(b64);
    } else if (line.startsWith("__SAM_CONFIG__:")) {
      try {
        config = JSON.parse(line.slice("__SAM_CONFIG__:".length).trim());
      } catch {
        otherLines.push(line);
      }
    } else {
      otherLines.push(line);
    }
  }

  const cleanStdout = otherLines.join("\n").trim();
  const hasOutput = result !== null || charts.length > 0;
  const error = processError && !hasOutput ? processError : null;

  return { result, charts, config, stdout: cleanStdout, stderr: stderr.trim(), error };
}

export async function getDatasetInfoPython(
  sessionId: string,
  upload: SessionUpload
): Promise<Record<string, unknown>> {
  const code = `
info = {
    "rowCount": len(df),
    "columns": list(df.columns),
    "dtypes": {col: str(df[col].dtype) for col in df.columns},
    "numericStats": {},
    "categoricalStats": {},
    "sampleRows": df.head(10).fillna('').to_dict(orient='records'),
}
for col in df.select_dtypes(include='number').columns:
    s = df[col].dropna()
    if len(s) > 0:
        info["numericStats"][col] = {
            "min": float(s.min()),
            "max": float(s.max()),
            "mean": round(float(s.mean()), 3),
            "median": float(s.median()),
            "nulls": int(df[col].isna().sum()),
            "uniqueCount": int(s.nunique()),
        }
for col in df.select_dtypes(exclude='number').columns:
    info["categoricalStats"][col] = {
        "uniqueCount": int(df[col].nunique()),
        "topValues": df[col].value_counts().head(5).to_dict(),
        "nulls": int(df[col].isna().sum()),
    }
print("__SAM_RESULT__:" + json.dumps(info, default=str))
`;

  const pyResult = await executePython(sessionId, upload, code);
  if (pyResult.result && typeof pyResult.result === "object") {
    return pyResult.result as Record<string, unknown>;
  }
  return {
    fileName: upload.fileName,
    rowCount: upload.rowCount,
    columns: upload.columns,
    numericColumns: upload.numericColumns,
    error: pyResult.stderr || "Failed to load dataset info",
  };
}
