# JarDIYn MCP integration notes

Target project:

- Repository: https://github.com/endersra/jardiyn-garden-hub
- Demo: https://endersra.github.io/jardiyn-garden-hub/jardiyn-final-submission/src/

Recommended location:

```text
jardiyn-final-submission/
  weather/
    package.json
    tsconfig.json
    .env.example
    src/index.ts
    README.md
```

Optional parent `package.json` script additions:

```json
{
  "scripts": {
    "mcp:install": "cd weather && npm install",
    "mcp:build": "cd weather && npm run build",
    "mcp:start": "cd weather && npm start",
    "mcp:inspect": "cd weather && npm run inspect"
  }
}
```

Because the v25 JarDIYn app is static/mock mode, this MCP server does not run in GitHub Pages. It runs locally over stdio and gives MCP clients tools that understand JarDIYn's project domain.
