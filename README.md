{
  "name": "@endersra/jardiyn-weather-mcp",
  "version": "1.0.0",
  "description": "Weather-aware MCP server for JarDIYn by GardenHub",
  "type": "module",
  "bin": {
    "jardiyn-weather-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node build/index.js",
    "inspect": "npx @modelcontextprotocol/inspector node build/index.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.8.0"
  },
  "license": "MIT"
}
