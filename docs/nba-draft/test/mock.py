import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
FX = json.load(open(sys.argv[1]))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        key = self.path.split('?')[0].lstrip('/')
        hits = sorted([k for k in FX if key == k or key.startswith(k)], key=len, reverse=True)
        if not hits:
            self.send_response(404); self.end_headers(); self.wfile.write(b'nf'); print('MISS', key, flush=True); return
        body = json.dumps(FX[hits[0]]).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
