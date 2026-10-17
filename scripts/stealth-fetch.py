"""One bounded LinkedIn request. Redirects and retries belong to the Node guard."""
import base64
import ipaddress
import json
import socket
import sys
from urllib.parse import urlsplit
from stealth_requests import StealthSession

url = sys.argv[1]
parsed = urlsplit(url)
if (parsed.scheme != 'https' or parsed.username or parsed.password or
        parsed.port not in (None, 443) or not parsed.hostname or
        not (parsed.hostname == 'linkedin.com' or parsed.hostname.endswith('.linkedin.com'))):
    raise ValueError('Only public LinkedIn HTTPS URLs are allowed')
for address in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM):
    if not ipaddress.ip_address(address[4][0]).is_global:
        raise ValueError('Non-public address rejected')
with StealthSession() as session:
    response = session.get(url, retry=0, timeout=15, allow_redirects=False, stream=True)
    try:
        data = bytearray()
        if response.status_code == 200:
            for chunk in response.iter_content():
                data.extend(chunk)
                if len(data) > 5 * 1024 * 1024:
                    raise ValueError('Response too large')
        print(json.dumps({'status': response.status_code,
                          'headers': {key: response.headers[key] for key in
                                      ('location', 'retry-after') if key in response.headers},
                          'body': base64.b64encode(data).decode('ascii')}))
    finally:
        response.close()
