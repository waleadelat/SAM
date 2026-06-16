export interface SamTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const SAM_TOOLS: SamTool[] = [
  {
    type: "function",
    function: {
      name: "get_dataset_info",
      description:
        "Get full metadata about the uploaded dataset: column names, data types, value ranges (min/max/mean/nulls) for every numeric column, unique value counts for categorical columns, total row count, and a sample of 10 rows. Call this first before any analysis to understand what is in the data.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_session_config",
      description:
        "Get the current session's resolved analysis configuration: detected asset type, condition column being used, and condition scale (e.g. nbi_0_9, pci_0_100, scale_0_100). Returns null if not yet determined. Use this to avoid re-detecting asset type on follow-up questions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_analysis_code",
      description: `Execute Python analysis code against the uploaded dataset. Use this to answer ANY question about the data that requires computation, aggregation, filtering, statistics, modeling, or chart generation.

ENVIRONMENT:
- pandas is imported as pd, numpy as np, scipy as sp, matplotlib.pyplot as plt, statsmodels.api as sm
- The dataset is already loaded as: df (a pandas DataFrame with all columns and rows)
- matplotlib uses the Agg non-interactive backend — do NOT call plt.show()

REQUIRED CONVENTIONS — you MUST use these to communicate results:
1. To return structured data the user will see: print("__SAM_RESULT__:" + json.dumps(your_dict_or_list))
2. To generate a chart: save it as PNG bytes and print("__SAM_CHART__:" + base64.b64encode(buf.getvalue()).decode())
3. To set the session's analysis config (asset type, condition column, scale): print("__SAM_CONFIG__:" + json.dumps({"assetType": "...", "conditionColumn": "...", "scale": "scale_0_100|nbi_0_9|pci_0_100|scale_0_10"}))
4. json and base64 are already imported

SELF-HEALING: If your code errors, you will see the stderr and must rewrite to fix it. Never apologize to the user — just retry.

CHART CONVENTION:
  fig, ax = plt.subplots(figsize=(10, 6))
  # ... plotting code ...
  buf = io.BytesIO()
  fig.savefig(buf, format='png', dpi=120, bbox_inches='tight')
  plt.close(fig)
  print("__SAM_CHART__:" + base64.b64encode(buf.getvalue()).decode())

NBI BRIDGE SCALE (nbi_0_9): Good=7-9, Fair=5-6, Poor=0-4
PCI PAVEMENT SCALE (pci_0_100): Very Good=85-100, Good=70-84, Fair=55-69, Poor=40-54, Very Poor<40
GENERIC SCALE (scale_0_100): Excellent>80, Good=61-80, Fair=41-60, Poor=21-40, Critical<=20`,
      parameters: {
        type: "object",
        properties: {
          python_code: {
            type: "string",
            description:
              "The Python code to execute. df is available. Use print(__SAM_RESULT__:...) for data, __SAM_CHART__: for charts, __SAM_CONFIG__: for session config.",
          },
          description: {
            type: "string",
            description:
              "A short human-readable description of what this code does, shown to the user while it runs. E.g. 'Analyzing bridge condition distribution by county'",
          },
        },
        required: ["python_code", "description"],
      },
    },
  },
];

export type SamToolName = "get_dataset_info" | "get_session_config" | "run_analysis_code";
