"""Run in umbrel-test. Reads production settings/DB; writes only the lab directory."""
from pathlib import Path
import json
import secrets
import sqlite3
import xml.etree.ElementTree as ET

source = Path('/data/app-data/jellyseerr/data/config')
target = Path('/data/seerr-availability-lab-snapshot')
if target.exists():
    raise RuntimeError('Refusing to overwrite an existing lab snapshot')
(target / 'db').mkdir(parents=True)
settings = json.loads((source / 'settings.json').read_text())
settings['main']['apiKey'] = secrets.token_hex(32)
settings['sessionSecret'] = secrets.token_hex(32)
settings['main']['applicationTitle'] = 'Seerr Availability Lab'
(target / 'settings.json').write_text(json.dumps(settings, indent=2))
with sqlite3.connect(f'file:{source / "db/db.sqlite3"}?mode=ro', uri=True) as original:
    with sqlite3.connect(target / 'db/db.sqlite3') as snapshot:
        original.backup(snapshot)
        # Sessions belong to the copied installation; users can sign in normally.
        tables = {r[0] for r in snapshot.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'session' in tables:
            snapshot.execute('DELETE FROM session')
        snapshot.commit()
key = ET.parse('/data/app-data/prowlarr/data/config/config.xml').findtext('ApiKey')
(target / 'availability-secrets.json').write_text(json.dumps({'prowlarrApiKey': key}))
(target / 'DOCKER').touch()
print('Consistent SQLite snapshot and independent settings created. No production files written.')
