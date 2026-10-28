"""Read-only snapshot of Prowlarr with every production write integration removed."""
from pathlib import Path
import shutil
import sqlite3
source = Path('/data/app-data/prowlarr/data/config')
target = Path('/data/seerr-availability-indexer-snapshot')
if target.exists():
    raise RuntimeError('Refusing to overwrite an existing lab snapshot')
target.mkdir()
shutil.copy2(source / 'config.xml', target / 'config.xml')
with sqlite3.connect(f'file:{source / "prowlarr.db"}?mode=ro', uri=True) as original:
    with sqlite3.connect(target / 'prowlarr.db') as snapshot:
        original.backup(snapshot)
        for table in ['ApplicationIndexerMapping', 'Applications', 'DownloadClients', 'Notifications', 'Commands', 'ApplicationStatus', 'DownloadClientStatus', 'NotificationStatus', 'IndexerStatus', 'History']:
            snapshot.execute(f'DELETE FROM "{table}"')
        snapshot.commit()
print('Isolated indexer snapshot created; no app sync, download clients, notifications, or inherited backoff.')
