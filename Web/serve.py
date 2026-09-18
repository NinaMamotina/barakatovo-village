import http.server
import functools
import os

DIRECTORY = os.path.dirname(os.path.abspath(__file__))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
print(f"Serving {DIRECTORY} on port 8080")
httpd.serve_forever()
