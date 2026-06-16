import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  getSession,
  addMessage,
  updateAnalysisConfig,
  addGeneratedChart,
  setLatestAnalysis,
  type AnalysisConfig,
} from "../../lib/sessionStore.js";
import { buildAgenticMessages } from "../../lib/samPrompt.js";
import { SAM_TOOLS } from "../../lib/samTools.js";
import { executePython, getDatasetInfoPython } from "../../lib/pythonExecutor.js";

type AnyMessage = { role: string; content: string | null; [k: string]: unknown };
type ToolResultMessage = { role: "tool"; tool_call_id: string; content: string };
type FunctionToolCall = { id: string; type: string; function: { name: string; arguments: string } };

const router = Router();

const MAX_ITERATIONS = 8;
const MAX_SELF_HEALS = 5;

async function execGetDatasetInfo(sessionId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (!session?.upload) {
    return JSON.stringify({ error: "No dataset uploaded. Ask the user to upload a CSV or Excel file." });
  }
  const info = await getDatasetInfoPython(sessionId, session.upload);
  return JSON.stringify(info, null, 2);
}

async function execGetSessionConfig(sessionId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (!session) return JSON.stringify({ error: "Session not found." });
  if (!session.analysisConfig) {
    return JSON.stringify({
      config: null,
      message: "No analysis config resolved yet. Call get_dataset_info to determine the asset type and condition column.",
    });
  }
  return JSON.stringify({ config: session.analysisConfig });
}

router.post("/sessions/:sessionId/messages", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const userContent: string = req.body?.content;
  if (!userContent || typeof userContent !== "string" || !userContent.trim()) {
    res.status(400).json({ error: "Message content is required." });
    return;
  }

  await addMessage(session.sessionId, { role: "user", content: userContent.trim() });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const initialMessages = buildAgenticMessages(
      session.upload ?? null,
      session.analysisConfig ?? null,
      session.messages.slice(0, -1),
      userContent.trim()
    );

    const messages: AnyMessage[] = initialMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let fullProseContent = "";
    let collectedCharts: string[] = [];
    let collectedResults: unknown[] = [];
    let selfHealCount = 0;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        messages: messages as any,
        tools: SAM_TOOLS as any,
        tool_choice: "auto",
        stream: false,
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      if (choice.finish_reason === "tool_calls" && assistantMessage.tool_calls?.length) {
        messages.push(assistantMessage as unknown as AnyMessage);

        if (assistantMessage.content?.trim()) {
          send({ type: "content", delta: assistantMessage.content });
          fullProseContent += assistantMessage.content;
        }

        const toolResults: ToolResultMessage[] = [];

        for (const rawToolCall of assistantMessage.tool_calls) {
          const toolCall = rawToolCall as FunctionToolCall;
          const { name } = toolCall.function;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            // ignore
          }

          if (name === "get_dataset_info") {
            send({ type: "tool_status", status: "Reading dataset schema and statistics…" });
            const result = await execGetDatasetInfo(session.sessionId);
            toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });

          } else if (name === "get_session_config") {
            send({ type: "tool_status", status: "Loading session configuration…" });
            const result = await execGetSessionConfig(session.sessionId);
            toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });

          } else if (name === "run_analysis_code") {
            const description = (args.description as string) || "Running analysis…";
            const pythonCode = (args.python_code as string) || "";

            send({ type: "tool_status", status: description });

            // Re-fetch session to get latest upload (may have changed since loop start)
            const currentSession = await getSession(session.sessionId);
            if (!currentSession?.upload) {
              toolResults.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: "No dataset uploaded. Cannot run Python code." }),
              });
              continue;
            }

            const pyResult = await executePython(session.sessionId, currentSession.upload, pythonCode);

            // Persist config if Python emitted __SAM_CONFIG__
            if (pyResult.config) {
              const cfg = pyResult.config;
              if (cfg.assetType && cfg.conditionColumn && cfg.scale) {
                await updateAnalysisConfig(session.sessionId, {
                  assetType: cfg.assetType,
                  conditionColumn: cfg.conditionColumn,
                  scale: cfg.scale as AnalysisConfig["scale"],
                });
                send({ type: "config", config: cfg });
              }
            }

            // Accumulate structured results
            if (pyResult.result !== null) {
              collectedResults.push(pyResult.result);
            }

            // Emit charts immediately so frontend can display them
            for (const chart of pyResult.charts) {
              collectedCharts.push(chart);
              await addGeneratedChart(session.sessionId, chart);
              send({ type: "chart", data: chart });
            }

            // Self-heal tracking
            const hasOutput = pyResult.result !== null || pyResult.charts.length > 0;
            const hasError = !!pyResult.stderr && !hasOutput;
            if (hasError && selfHealCount < MAX_SELF_HEALS) {
              selfHealCount++;
              send({ type: "tool_status", status: `Fixing code error (attempt ${selfHealCount})…` });
            }

            // Build tool result
            const toolContent: Record<string, unknown> = {};
            if (pyResult.result !== null) toolContent.result = pyResult.result;
            if (pyResult.charts.length > 0) toolContent.chartsGenerated = pyResult.charts.length;
            if (pyResult.config) toolContent.configSet = pyResult.config;
            if (pyResult.stdout) toolContent.stdout = pyResult.stdout.slice(0, 4000);
            if (pyResult.stderr) toolContent.stderr = pyResult.stderr.slice(0, 2000);
            if (pyResult.error) toolContent.executionError = pyResult.error;
            if (Object.keys(toolContent).length === 0) toolContent.status = "Code executed (no output produced)";

            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolContent),
            });

          } else {
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: `Unknown tool: ${name}` }),
            });
          }
        }

        messages.push(...toolResults);
        continue;
      }

      // Final response — stream in chunks for smooth UI
      const finalContent = assistantMessage.content ?? "";
      if (finalContent.trim()) {
        const CHUNK = 40;
        for (let i = 0; i < finalContent.length; i += CHUNK) {
          send({ type: "content", delta: finalContent.slice(i, i + CHUNK) });
        }
        fullProseContent += finalContent;
      }
      break;
    }

    // Send final analysis SSE — includes charts, results, and config
    const updatedSession = await getSession(session.sessionId);
    let analysis: Record<string, unknown> | null = null;
    const hasAnalysis =
      collectedCharts.length > 0 ||
      collectedResults.length > 0 ||
      updatedSession?.analysisConfig != null;
    if (hasAnalysis) {
      analysis = {
        charts: collectedCharts,
        results: collectedResults,
        latestResult: collectedResults.length > 0 ? collectedResults[collectedResults.length - 1] : null,
        analysisConfig: updatedSession?.analysisConfig ?? null,
        allCharts: updatedSession?.generatedCharts ?? [],
      };
      await setLatestAnalysis(session.sessionId, analysis);
      send({ type: "analysis", data: analysis });
    }

    await addMessage(session.sessionId, {
      role: "assistant",
      content: fullProseContent,
      analysis,
    });

    send({ type: "done" });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "An error occurred";
    send({ type: "error", message });
    res.end();
  }
});

export default router;
