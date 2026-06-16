# SAM — Asset Management Agent

Full-stack AI agent for infrastructure asset management.

## Structure

| Folder | Description |
|--------|-------------|
| `src/` | React + TypeScript frontend (Vite) |
| `api-server/` | Node.js / TypeScript backend (Express + OpenAI) |
| `lib/db/` | Drizzle ORM schema (PostgreSQL) |
| `lib/api-zod/` | Shared Zod types & API spec |
| `lib/integrations-openai-ai-server/` | OpenAI integration helpers |

## Getting started

```bash
# Install dependencies (requires pnpm)
pnpm install

# Run frontend
cd <root>
pnpm --filter @workspace/sam-app run dev

# Run backend
pnpm --filter @workspace/api-server run dev
```

Requires a PostgreSQL `DATABASE_URL` environment variable.
