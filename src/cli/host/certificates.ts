import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOST_DIR } from "./paths";

export const TLS_KEY_FILE = path.join(HOST_DIR, "host.key");
export const TLS_CERT_FILE = path.join(HOST_DIR, "host.crt");

function hasCertificate(): boolean {
  return fs.existsSync(TLS_KEY_FILE) && fs.existsSync(TLS_CERT_FILE);
}

export function ensureHostCertificate(): { ok: boolean; trusted: boolean; error?: string } {
  fs.mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 });
  if (hasCertificate()) return { ok: true, trusted: false };

  // Try mkcert first - it creates system-trusted certificates
  try {
    // Check if mkcert is available
    execFileSync("mkcert", ["-version"], { stdio: "ignore" });
    execFileSync("mkcert", ["-install"], { stdio: "ignore" });
    execFileSync("mkcert", ["-cert-file", TLS_CERT_FILE, "-key-file", TLS_KEY_FILE, "localhost", "127.0.0.1", "::1", "*.lasso"], { stdio: "ignore" });
    fs.chmodSync(TLS_KEY_FILE, 0o600);
    return { ok: true, trusted: true };
  } catch (mkcertError) {
    console.warn("[Lasso] mkcert not available or failed, falling back to OpenSSL (certificate will show as not secure)");
    console.warn("[Lasso] To fix this, install mkcert: https://mkcert.dev/");
    console.warn("[Lasso] After installing, run: mkcert -install && rm -rf ~/.lasso/host && lasso daemon restart");
  }

  // Fallback to OpenSSL - creates self-signed certificate (not trusted by browsers)
  const configFile = path.join(os.tmpdir(), `lasso-host-${process.pid}.cnf`);
  try {
    fs.writeFileSync(configFile, [
      "[req]", "distinguished_name = req_distinguished_name", "x509_extensions = v3_req", "prompt = no",
      "[req_distinguished_name]", "CN = *.lasso", "[v3_req]",
      "subjectAltName = DNS:*.lasso,DNS:localhost,IP:127.0.0.1,IP:::1", "",
    ].join("\n"), { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", TLS_KEY_FILE, "-out", TLS_CERT_FILE, "-days", "825", "-config", configFile], { stdio: "ignore" });
    fs.chmodSync(TLS_KEY_FILE, 0o600);
    return { ok: true, trusted: false };
  } catch (error) {
    return { ok: false, trusted: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(configFile, { force: true });
  }
}

export function hostCertificateStatus(): { present: boolean; certificate: string; key: string; trusted: boolean } {
  // Check if certificate was created by mkcert (trusted) or OpenSSL (self-signed)
  let trusted = false;
  if (hasCertificate()) {
    try {
      const certContent = fs.readFileSync(TLS_CERT_FILE, "utf8");
      // mkcert certificates include "mkcert" in the issuer
      trusted = certContent.includes("mkcert");
    } catch {
      // If we can't read the cert, assume not trusted
    }
  }
  return { present: hasCertificate(), certificate: TLS_CERT_FILE, key: TLS_KEY_FILE, trusted };
}
