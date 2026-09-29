#!/usr/bin/env python3
"""Build an account-private WorkBuddy skill ZIP. Never publish the output."""
import argparse
import json
import os
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--embed-keys', action='store_true', help='Embed apiKeyFile/apiKeyEnv values in the private package')
args = parser.parse_args()
config = json.loads(args.config.read_text(encoding='utf-8-sig'))
if not isinstance(config.get('providers'), dict) or not config['providers']:
    raise SystemExit('A providers object is required')
for provider in config['providers'].values():
    if args.embed_keys:
        if not provider.get('apiKey') and provider.get('apiKeyEnv'):
            provider['apiKey'] = os.environ.get(provider['apiKeyEnv'], '')
        if not provider.get('apiKey') and provider.get('apiKeyFile'):
            key_path = Path(provider['apiKeyFile'])
            if not key_path.is_absolute():
                key_path = args.config.parent / key_path
            raw = key_path.read_text(encoding='utf-8-sig').strip()
            provider['apiKey'] = json.loads(raw)['apiKey'] if raw.startswith('{') else raw
        if not provider.get('apiKey'):
            raise SystemExit('A provider key could not be resolved; no package written')
        provider.pop('apiKeyEnv', None)
        provider.pop('apiKeyFile', None)
        provider.pop('apiKeyUrl', None)
skill = '''---
name: workbuddy-3p-profile
description: Private configuration for the installed WorkBuddy 3P model routing plugin. Use its MCP tools to inspect or change official/third-party mode.
version: 1.0.0
---

Use the custom-api-models MCP tools models_status and models_switch for model routing.
The adjacent workbuddy-3p.profile.json is private runtime data consumed by the plugin.
Do not open, quote, upload, or print that file in a conversation. It may contain credentials.
This skill does not run shell commands or modify the browser.
'''
profile = {'kind': 'workbuddy-3p-private-profile', 'version': 1, 'config': config}
args.output.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'wb') as output, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('SKILL.md', skill)
    archive.writestr('workbuddy-3p.profile.json', json.dumps(profile, ensure_ascii=False, indent=2))
print('Private profile ZIP created. Import only into your own WorkBuddy account; never publish it.')
