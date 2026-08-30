# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow from the repository's **Security** tab so maintainers can investigate before disclosure.

Include the affected version, configuration, impact, reproduction steps, and any suggested mitigation. Do not include live API keys, tokens, workspace content, or other credentials in the report.

## Supported versions

Until the project reaches 1.0, security fixes are applied to the latest published npm version and the `main` branch.

## Authenticated sender boundary

Knot authorizes an Anytype sender only from the immutable native participant/member ID carried by the inbound Anytype event. Display names are informational and may collide or change. Message text, mentions, replies, quoted or forwarded content, and agent-generated assertions are never identity evidence and cannot grant Raj/operator/admin privileges.

Wake allowlists and privileged route, access, model, project, and self-management operations compare the authenticated native ID with locally configured immutable-ID allowlists. Missing, malformed, or non-native provenance fails closed. Security reports should treat any path that authorizes from a visible name or content claim as a vulnerability.
