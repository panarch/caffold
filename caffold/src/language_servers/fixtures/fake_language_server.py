#!/usr/bin/env python3
"""LSP wire fixture standing in for a language server; it does no analysis.

Modes (first argument):
  status              reports indexing and readiness the way rust-analyzer
                      does, once it has the client's configuration answer.
  initialized         reports nothing after the handshake.
  exit-on-definition  like `status`, but exits instead of answering a
                      definition request.

A definition always points at `pub fn helper` on the third line of
`src/target.rs` in the root. References are the lines of the asked document
that call `helper(` in the text the fixture was last sent.
"""
import json
import sys

MODE = sys.argv[1] if len(sys.argv) > 1 else "status"
ROOT_URI = ""
DOCUMENTS = {}


def read():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.decode().strip()
        if not line:
            break
        name, _, value = line.partition(":")
        if name.lower() == "content-length":
            length = int(value.strip())
    return json.loads(sys.stdin.buffer.read(length))


def send(message):
    message["jsonrpc"] = "2.0"
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    sys.stdout.buffer.flush()


def location(uri, line, character, length):
    return {"uri": uri, "range": {"start": {"line": line, "character": character},
                                  "end": {"line": line, "character": character + length}}}


def progress(kind, **fields):
    send({"method": "$/progress", "params": {"token": "index", "value": {"kind": kind, **fields}}})


def handle(message):
    global ROOT_URI
    method = message.get("method")
    if method == "initialize":
        ROOT_URI = message["params"]["rootUri"]
        send({"id": message["id"], "result": {"capabilities": {"definitionProvider": True}}})
    elif method == "initialized" and MODE != "initialized":
        send({"method": "experimental/serverStatus", "params": {"health": "ok", "quiescent": False}})
        send({"id": "configuration", "method": "workspace/configuration",
              "params": {"items": [{"section": "rust-analyzer"}]}})
    elif message.get("id") == "configuration" and "method" not in message:
        if message["result"][0]["cargo"]["targetDir"] is True:
            progress("begin", title="Indexing")
            progress("report", message="1/2 (core)")
            progress("end")
            send({"method": "experimental/serverStatus", "params": {"health": "ok", "quiescent": True}})
    elif method == "textDocument/didOpen":
        document = message["params"]["textDocument"]
        DOCUMENTS[document["uri"]] = document["text"]
    elif method == "textDocument/didChange":
        uri = message["params"]["textDocument"]["uri"]
        DOCUMENTS[uri] = message["params"]["contentChanges"][-1]["text"]
    elif method == "textDocument/didClose":
        DOCUMENTS.pop(message["params"]["textDocument"]["uri"], None)
    elif method == "textDocument/definition":
        if MODE == "exit-on-definition":
            sys.exit(0)
        uri = message["params"]["textDocument"]["uri"]
        if uri not in DOCUMENTS:
            send({"id": message["id"], "error": {"code": -32602, "message": "document is not open"}})
            return
        send({"id": message["id"], "result": [location(ROOT_URI + "src/target.rs", 2, 7, len("helper"))]})
    elif method == "textDocument/references":
        uri = message["params"]["textDocument"]["uri"]
        lines = DOCUMENTS.get(uri, "").split("\n")
        declaration = message["params"]["context"]["includeDeclaration"]
        result = [
            location(uri, number, line.index("helper("), len("helper"))
            for number, line in enumerate(lines)
            if "helper(" in line and (declaration or "fn helper" not in line)
        ]
        send({"id": message["id"], "result": result})
    elif method == "shutdown":
        send({"id": message["id"], "result": None})
    elif method == "exit":
        sys.exit(0)


while True:
    message = read()
    if message is None:
        break
    handle(message)
