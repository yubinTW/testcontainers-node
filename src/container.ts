import dockerode, { ContainerInspectInfo } from "dockerode";
import { log } from "./logger";
import { Command, ContainerName, ExitCode } from "./docker-client";
import { Port } from "./port";
import { Duplex, Readable } from "stream";
import streamToArray from "stream-to-array";

export type Id = string;

export type HealthCheckStatus = "none" | "starting" | "unhealthy" | "healthy";

export type NetworkSettings = {
  networkId: string;
  ipAddress: string;
};

export type InspectResult = {
  name: ContainerName;
  internalPorts: Port[];
  hostPorts: Port[];
  healthCheckStatus: HealthCheckStatus;
  networkSettings: { [networkName: string]: NetworkSettings };
};

type ExecInspectResult = {
  exitCode: ExitCode;
  running: boolean;
  entrypoint: string;
  arguments: string[];
};

interface Exec {
  start(): Promise<NodeJS.ReadableStream>;
  inspect(): Promise<ExecInspectResult>;
}

type ExecOptions = {
  cmd: Command[];
  attachStdout: true;
  attachStderr: true;
};

type StopOptions = {
  timeout: number;
};

type RemoveOptions = {
  removeVolumes: boolean;
};

export interface Container {
  getId(): Id;
  start(): Promise<void>;
  stop(options: StopOptions): Promise<void>;
  remove(options: RemoveOptions): Promise<void>;
  exec(options: ExecOptions): Promise<Exec>;
  logs(): Promise<Readable>;
  inspect(): Promise<InspectResult>;
  putArchive(stream: Readable, containerPath: string): Promise<void>;
}

export class DockerodeContainer implements Container {
  constructor(private readonly container: dockerode.Container) {}

  public getId(): Id {
    return this.container.id;
  }

  public start(): Promise<void> {
    return this.container.start();
  }

  public stop(options: StopOptions): Promise<void> {
    return this.container
      .stop({
        t: options.timeout / 1000,
      })
      .catch((error) => {
        /* 304 container already stopped */
        if (error.statusCode === 304) {
          log.info(`Container has already been stopped: ${this.getId()}`);
        } else {
          throw error;
        }
      });
  }

  public remove(options: RemoveOptions): Promise<void> {
    return this.container.remove({
      v: options.removeVolumes,
    });
  }

  public async exec(options: ExecOptions): Promise<Exec> {
    return new DockerodeExec(
      await this.container.exec({
        Cmd: options.cmd,
        AttachStdout: options.attachStdout,
        AttachStderr: options.attachStderr,
      })
    );
  }

  public async logs(): Promise<Readable> {
    const options = {
      follow: true,
      stdout: true,
      stderr: true,
    };
    return (await this.container.logs(options)).setEncoding("utf-8") as Readable;
  }

  public async inspect(): Promise<InspectResult> {
    const inspectResult = await this.container.inspect();
    return {
      hostPorts: this.getHostPorts(inspectResult),
      internalPorts: this.getInternalPorts(inspectResult),
      name: this.getName(inspectResult),
      healthCheckStatus: this.getHealthCheckStatus(inspectResult),
      networkSettings: this.getNetworkSettings(inspectResult),
    };
  }

  public async putArchive(stream: Readable, containerPath: string): Promise<void> {
    const respStream = await this.container.putArchive(stream, { path: containerPath });
    await streamToArray(respStream);
  }

  private getName(inspectInfo: ContainerInspectInfo): ContainerName {
    return inspectInfo.Name;
  }

  private getInternalPorts(inspectInfo: ContainerInspectInfo): Port[] {
    return Object.keys(inspectInfo.NetworkSettings.Ports).map((port) => Number(port.split("/")[0]));
  }

  private getHostPorts(inspectInfo: ContainerInspectInfo): Port[] {
    return Object.values(inspectInfo.NetworkSettings.Ports)
      .filter((portsArray) => portsArray !== null)
      .map((portsArray) => Number(portsArray[0].HostPort));
  }

  private getHealthCheckStatus(inspectResult: ContainerInspectInfo): HealthCheckStatus {
    const health = inspectResult.State.Health;
    if (health === undefined) {
      return "none";
    } else {
      return health.Status as HealthCheckStatus;
    }
  }

  private getNetworkSettings(inspectResult: ContainerInspectInfo): { [networkName: string]: NetworkSettings } {
    return Object.entries(inspectResult.NetworkSettings.Networks)
      .map(([networkName, network]) => ({
        [networkName]: {
          networkId: network.NetworkID,
          ipAddress: network.IPAddress,
        },
      }))
      .reduce((prev, next) => ({ ...prev, ...next }), {});
  }
}

class DockerodeExec implements Exec {
  constructor(private readonly exec: dockerode.Exec) {}

  public start(): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
      const options = { Detach: false, Tty: true, stream: true, stdin: true, stdout: true, stderr: true };
      this.exec.start(options, (err?: Error, stream?: Duplex) => {
        if (err) {
          return reject(err);
        } else if (!stream) {
          return reject(new Error("Unexpected error occurred, stream is undefined"));
        }
        return resolve(stream);
      });
    });
  }

  public async inspect(): Promise<ExecInspectResult> {
    const inspectResult = await this.exec.inspect();

    return {
      exitCode: inspectResult.ExitCode === null ? -1 : inspectResult.ExitCode,
      running: inspectResult.Running,
      entrypoint: inspectResult.ProcessConfig.entrypoint,
      arguments: inspectResult.ProcessConfig.arguments,
    };
  }
}
