# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅ Yes    |

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Email: security@kinetexjs.dev (or open a [GitHub Security Advisory](https://github.com/kinetexjs/kinetex/security/advisories/new))

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive a response within 48 hours. We aim to release a patch within 7 days for critical issues.

## Scope

- Credential leakage in logs or HAR recordings
- SSRF via proxy/redirect configurations
- Cookie jar cross-origin leakage
- Prototype pollution in request/response handling
- Dependency vulnerabilities (please also report upstream)

## Out of Scope

- Issues requiring physical access to the machine
- Social engineering
- Vulnerabilities in user-configured third-party code
