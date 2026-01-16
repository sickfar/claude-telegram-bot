/**
 * Audit logger with automatic log rotation.
 *
 * Features:
 * - Size-based rotation (default: 10MB)
 * - Keep N rotated files (default: 5)
 * - Rotation state tracking
 * - Supports both JSON and plain text formats
 */

import { existsSync, mkdirSync, statSync, renameSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname, basename } from "path";
import type { AuditEvent } from "./types";

export interface AuditLoggerConfig {
  logPath: string;
  maxSizeMB: number;
  maxFiles: number;
  jsonFormat: boolean;
}

interface RotationState {
  last_rotation: string;
  rotation_count: number;
  current_size_bytes: number;
}

/**
 * Audit logger with automatic rotation.
 */
export class AuditLogger {
  private config: AuditLoggerConfig;
  private rotationStatePath: string;

  constructor(config: AuditLoggerConfig) {
    this.config = config;
    const logDir = dirname(config.logPath);
    this.rotationStatePath = `${logDir}/.rotation-state`;

    // Ensure log directory exists
    this.ensureLogDirectory();
  }

  /**
   * Log an audit event.
   */
  async log(event: AuditEvent): Promise<void> {
    try {
      // Check if rotation is needed before writing
      await this.checkAndRotate();

      // Format content
      let content: string;
      if (this.config.jsonFormat) {
        content = JSON.stringify(event) + "\n";
      } else {
        // Plain text format for readability
        const lines = ["\n" + "=".repeat(60)];
        for (const [key, value] of Object.entries(event)) {
          let displayValue = value;
          if (
            (key === "content" || key === "response") &&
            String(value).length > 500
          ) {
            displayValue = String(value).slice(0, 500) + "...";
          }
          lines.push(`${key}: ${displayValue}`);
        }
        content = lines.join("\n") + "\n";
      }

      // Append to log file
      await appendFile(this.config.logPath, content);

      // Update rotation state
      await this.updateRotationState(content.length);
    } catch (error) {
      console.error("Failed to write audit log:", error);
    }
  }

  /**
   * Ensure log directory exists.
   */
  private ensureLogDirectory(): void {
    const logDir = dirname(this.config.logPath);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
      console.log(`Created audit log directory: ${logDir}`);
    }
  }

  /**
   * Check if rotation is needed and perform rotation.
   */
  private async checkAndRotate(): Promise<void> {
    if (!existsSync(this.config.logPath)) {
      return; // No file to rotate
    }

    const stats = statSync(this.config.logPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB >= this.config.maxSizeMB) {
      await this.rotate();
    }
  }

  /**
   * Perform log rotation.
   */
  private async rotate(): Promise<void> {
    console.log(
      `Rotating audit log (size: ${(statSync(this.config.logPath).size / 1024 / 1024).toFixed(2)}MB)`
    );

    const logDir = dirname(this.config.logPath);
    const logFile = basename(this.config.logPath);

    // Shift existing rotated files: .4 → .5, .3 → .4, etc.
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const oldPath = `${logDir}/${logFile}.${i}`;
      const newPath = `${logDir}/${logFile}.${i + 1}`;

      if (existsSync(oldPath)) {
        if (i === this.config.maxFiles - 1) {
          // Delete oldest file
          try {
            const fs = await import("fs");
            fs.unlinkSync(oldPath);
            console.log(`Deleted oldest rotated log: ${oldPath}`);
          } catch (error) {
            console.warn(`Failed to delete ${oldPath}:`, error);
          }
        } else {
          // Shift file
          try {
            renameSync(oldPath, newPath);
          } catch (error) {
            console.warn(`Failed to rename ${oldPath} → ${newPath}:`, error);
          }
        }
      }
    }

    // Rename current log to .1
    const rotatedPath = `${this.config.logPath}.1`;
    try {
      renameSync(this.config.logPath, rotatedPath);
      console.log(`Rotated log: ${this.config.logPath} → ${rotatedPath}`);
    } catch (error) {
      console.error("Failed to rotate log:", error);
      return;
    }

    // Update rotation state
    const state = this.loadRotationState();
    state.last_rotation = new Date().toISOString();
    state.rotation_count += 1;
    state.current_size_bytes = 0;
    this.saveRotationState(state);
  }

  /**
   * Load rotation state from file.
   */
  private loadRotationState(): RotationState {
    if (!existsSync(this.rotationStatePath)) {
      return {
        last_rotation: new Date().toISOString(),
        rotation_count: 0,
        current_size_bytes: 0,
      };
    }

    try {
      const fs = require("fs");
      const content = fs.readFileSync(this.rotationStatePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.warn("Failed to load rotation state:", error);
      return {
        last_rotation: new Date().toISOString(),
        rotation_count: 0,
        current_size_bytes: 0,
      };
    }
  }

  /**
   * Save rotation state to file.
   */
  private saveRotationState(state: RotationState): void {
    try {
      const fs = require("fs");
      fs.writeFileSync(
        this.rotationStatePath,
        JSON.stringify(state, null, 2)
      );
    } catch (error) {
      console.warn("Failed to save rotation state:", error);
    }
  }

  /**
   * Update rotation state after writing.
   */
  private async updateRotationState(bytesWritten: number): Promise<void> {
    const state = this.loadRotationState();
    state.current_size_bytes += bytesWritten;
    this.saveRotationState(state);
  }

  /**
   * Get rotation statistics.
   */
  getStats(): {
    current_size_mb: number;
    rotation_count: number;
    last_rotation: string | null;
  } {
    const state = this.loadRotationState();
    const currentSizeMB = existsSync(this.config.logPath)
      ? statSync(this.config.logPath).size / (1024 * 1024)
      : 0;

    return {
      current_size_mb: currentSizeMB,
      rotation_count: state.rotation_count,
      last_rotation: state.rotation_count > 0 ? state.last_rotation : null,
    };
  }
}
