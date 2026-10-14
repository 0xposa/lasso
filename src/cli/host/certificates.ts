import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { HOST_DIR } from "./paths";

export const TLS_KEY_FILE = path.join(HOST_DIR, "host.key");
export const TLS_CERT_FILE = path.join(HOST_DIR, "host.crt");

function hasCertificate(): boolean {
  return fs.existsSync(TLS_KEY_FILE) && fs.existsSync(TLS_CERT_FILE);
}

function isMkcertInstalled(): boolean {
  try {
    execFileSync("mkcert", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function installMkcert(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const platform = os.platform();
    let installCommand: string;
    let installArgs: string[];

    if (platform === "darwin") {
      // macOS: Check if Homebrew is available
      try {
        execFileSync("brew", ["--version"], { stdio: "ignore" });
        installCommand = "brew";
        installArgs = ["install", "mkcert", "nss"];
      } catch {
        // Homebrew not available or not working (e.g., Intel Mac unsupported)
        return resolve({ ok: false, error: "Homebrew not available or unsupported. Please install mkcert manually: https://mkcert.dev/\nThen run: mkcert -install && rm -rf ~/.lasso/host && lasso daemon restart" });
      }
    } else if (platform === "linux") {
      // Linux: Try different package managers
      try {
        execFileSync("apt-get", ["--version"], { stdio: "ignore" });
        installCommand = "sudo";
        installArgs = ["apt-get", "install", "-y", "mkcert"];
      } catch {
        try {
          execFileSync("dnf", ["--version"], { stdio: "ignore" });
          installCommand = "sudo";
          installArgs = ["dnf", "install", "-y", "mkcert"];
        } catch {
          return resolve({ ok: false, error: "Could not detect package manager. Please install mkcert manually: https://mkcert.dev/" });
        }
      }
    } else {
      return resolve({ ok: false, error: `Automatic mkcert installation not supported on ${platform}. Please install manually: https://mkcert.dev/` });
    }

    console.log(`[Lasso] Installing mkcert (this may require sudo password)...`);
    const install = spawn(installCommand, installArgs, { stdio: "inherit" });

    install.on("close", (code) => {
      if (code === 0) {
        // Install the local CA
        try {
          execFileSync("mkcert", ["-install"], { stdio: "ignore" });
          console.log("[Lasso] ✓ mkcert installed and CA configured");
          resolve({ ok: true });
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        resolve({ ok: false, error: `mkcert installation failed with code ${code}` });
      }
    });

    install.on("error", (error) => {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });
}

export async function ensureHostCertificate(onProgress?: (message: string) => void): Promise<{ ok: boolean; trusted: boolean; error?: string }> {
  fs.mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 });
  if (hasCertificate()) {
    const certStatus = hostCertificateStatus();
    return { ok: true, trusted: certStatus.trusted };
  }

  onProgress?.("Generating SSL certificate...");

  // Try mkcert first - it creates system-trusted certificates
  if (!isMkcertInstalled()) {
    onProgress?.("mkcert not found, installing...");
    const installResult = await installMkcert();
    if (!installResult.ok) {
      console.warn(`[Lasso] ${installResult.error}`);
      console.warn("[Lasso] Falling back to OpenSSL (certificate will show as not secure)");
    }
  }

  if (isMkcertInstalled()) {
    try {
      onProgress?.("Creating trusted certificate with mkcert...");
      execFileSync("mkcert", ["-cert-file", TLS_CERT_FILE, "-key-file", TLS_KEY_FILE, "localhost", "127.0.0.1", "::1", "*.lasso"], { stdio: "ignore" });
      fs.chmodSync(TLS_KEY_FILE, 0o600);
      onProgress?.("✓ SSL certificate ready (trusted)");
      return { ok: true, trusted: true };
    } catch (mkcertError) {
      console.warn("[Lasso] mkcert failed, falling back to OpenSSL");
    }
  }

  // Fallback to OpenSSL - creates self-signed certificate (not trusted by browsers)
  const configFile = path.join(os.tmpdir(), `lasso-host-${process.pid}.cnf`);
  try {
    onProgress?.("Creating self-signed certificate with OpenSSL...");
    fs.writeFileSync(configFile, [
      "[req]", "distinguished_name = req_distinguished_name", "x509_extensions = v3_req", "prompt = no",
      "[req_distinguished_name]", "CN = *.lasso", "[v3_req]",
      "subjectAltName = DNS:*.lasso,DNS:localhost,IP:127.0.0.1,IP:::1", "",
    ].join("\n"), { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", TLS_KEY_FILE, "-out", TLS_CERT_FILE, "-days", "825", "-config", configFile], { stdio: "ignore" });
    fs.chmodSync(TLS_KEY_FILE, 0o600);
    onProgress?.("✓ SSL certificate ready (self-signed)");
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
