# Oura companion

This instruction-only plugin accompanies a separately connected Oura MCP.
Installing it does not host a server, grant access, or add credentials.

Connect your own MCP endpoint using the client-specific instructions at
https://github.com/Allmight97/oura-mcp#connect-an-agent, then invoke the `oura`
skill. This package contains no account information or default server URL.

Install the Claude companion with:

```bash
claude plugin marketplace add Allmight97/oura-mcp
claude plugin install oura@oura
```
