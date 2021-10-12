import { EventEmitter } from 'events';
import { Readable } from 'stream';
// @ts-ignore
import { RTCVideoSource, RTCAudioSource, nonstandard } from 'wrtc';
import {
    RemotePlayingTimeCallback,
    StreamOptions,
    RemoteLaggingCallback,
} from './types';

export declare interface Stream {
    on(event: 'pause', listener: (paused: boolean) => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'almost-finished', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string, listener: Function): this;
}

export class Stream extends EventEmitter {
    private readonly audioSource: RTCAudioSource;
    private readonly videoSource: RTCVideoSource;
    private readable?: Readable;

    private cacheArray: Buffer[];
    private _readablePaused = false;
    private _paused = false;
    private _finished = true;
    private _stopped = false;
    private _finishedLoading = false;
    private _emittedAlmostFinished = false;
    private lastDifferenceRemote = 0;
    private video: boolean = false;
    public width: number = 640;
    public height: number = 360;
    private framerate: number = 24;
    private bitsPerSample: number = 16;
    private sampleRate: number = 65000;
    private channelCount: number = 1;
    private almostFinishedTrigger: number = 20;
    private byteLength: number = 0;
    private cacheSize: number = 0;
    private playedBytes = 0;
    private chunk: Buffer;
    remotePlayingTime?: RemotePlayingTimeCallback;
    remoteLagging?: RemoteLaggingCallback;
    private bindedProcess: CallableFunction;
    private processTimer?: number;
    private requiredTime?: number;
    private frameSize?: number;
    private _emittedReadyPlay: boolean = false;
    constructor(readable?: Readable, options?: StreamOptions) {
        super();
        this.audioSource = new nonstandard.RTCAudioSource();
        this.videoSource = new nonstandard.RTCVideoSource();
        this.cacheArray = [];
        this.chunk = Buffer.alloc(this.byteLength!);
        this.bindedProcess = this.processData.bind(this);

        this.setOptions(options);
        this.setReadable(readable);
        setTimeout(this.bindedProcess, 1);
    }
    setOptions(options?: StreamOptions) {
        if (typeof options?.video === 'boolean') {
            this.video = options?.video ?? true;
        } else if (options?.video) {
            this.video = true;
            this.width = options.video.width ?? this.width;
            this.height = options.video.height ?? this.height;
            this.framerate = options.video.framerate ?? this.framerate;
        }

        this.bitsPerSample = options?.audio?.bitsPerSample ?? 16;
        this.sampleRate = options?.audio?.sampleRate ?? 65000;
        this.channelCount = options?.audio?.channelCount ?? 1;
        this.almostFinishedTrigger = options?.almostFinishedTrigger ?? 20;
        // 5 sec video and 60 sec audio will be cached in buffer
        this.requiredTime = this.video ? 5 : 10;
        this.frameSize = this.video ? this.framerate : 100;
        this.byteLength = this.video
            ? 1.5 * this.width * this.height
            : ((this.sampleRate * this.bitsPerSample) / 8 / 100) *
              this.channelCount;
    }
    setReadable(readable?: Readable) {
        if (this._stopped) {
            throw new Error('Cannot set readable when stopped');
        }

        if (this.readable) {
            this.readable.removeListener('data', this.dataListener);
            this.readable.removeListener('end', this.endListener);
            this.readable.destroy();
            this.readable = undefined;
        }

        if (readable) {
            this._finished = false;
            this._finishedLoading = false;
            this._emittedAlmostFinished = false;
            this._emittedReadyPlay = false;
            this._readablePaused = false;
            this.lastDifferenceRemote = 0;
            this.readable = readable;
            this.cacheArray.splice(0, this.cacheArray.length);
            this.cacheSize = 0;
            this.playedBytes = 0;
            this.chunk = Buffer.alloc(this.byteLength);
            this.readable.addListener('data', this.dataListener);
            this.readable.addListener('end', this.endListener);
        }
    }

    pause() {
        if (this._stopped) {
            throw new Error('Cannot pause when stopped');
        }

        this._paused = !this._paused;
        this.emit('pause', this._paused);
    }

    get paused() {
        return this._paused;
    }

    finish() {
        this._finished = true;
        this.emit('finish');
    }

    get finished() {
        return this._finished;
    }

    stop() {
        this.finish();
        this._stopped = true;
    }

    get stopped() {
        return this._stopped;
    }

    createTrack() {
        return this.video
            ? this.videoSource.createTrack()
            : this.audioSource.createTrack();
    }

    get cachedTime() {
        return this.cacheSize / this.byteLength / this.frameSize!;
    }
    private checkOverflow() {
        if (this._finishedLoading) return;
        if (!this._readablePaused && this.cachedTime > this.requiredTime!) {
            this._readablePaused = true;
            this.readable!.pause();
            //  console.log('Paused', this.cachedTime);
        } else if (this.cachedTime < this.requiredTime! / 2) {
            if (this._readablePaused || this.readable?.isPaused()) {
                this._readablePaused = false;
                //   console.log('Resumed', this.cachedTime);
                this.readable!.resume();
            }
        }
    }
    private dataListener = ((data: Buffer) => {
        this.cacheArray.push(data);
        this.cacheSize += data.length;
        if (
            !this._emittedReadyPlay &&
            this.cachedTime > this.requiredTime! / 2
        ) {
            this._emittedReadyPlay = true;
            this.emit('ready');
        }
        // this.checkOverflow();
    }).bind(this);

    private endListener = (() => {
        console.log('Loading finished!');
        this._finishedLoading = true;
    }).bind(this);
    private isLaggingRemote() {
        if (
            this.remotePlayingTime != undefined &&
            !this.paused &&
            this.remoteLagging != undefined
        ) {
            const remote_play_time = this.remotePlayingTime().time;
            const local_play_time = this.currentPlayedTime();
            if (remote_play_time != undefined && local_play_time != undefined) {
                if (local_play_time > remote_play_time) {
                    this.lastDifferenceRemote =
                        (local_play_time - remote_play_time) * 100000;
                    return true;
                } else if (
                    this.remoteLagging().isLagging &&
                    remote_play_time > local_play_time
                ) {
                    this.lastDifferenceRemote = 0;
                    return true;
                }
            }
        }
        return false;
    }

    private processData() {
        if (this._stopped || !this.readable) {
            return;
        }
        const lagging_remote = this.isLaggingRemote();
        this.checkOverflow();
        const timeoutWait = this.frameTime() - this.lastDifferenceRemote;
        this.processTimer = setTimeout(this.bindedProcess, timeoutWait);
        if (
            !this._paused &&
            !this._finished &&
            !lagging_remote &&
            (this.cacheSize >= this.byteLength || this._finishedLoading)
        ) {
            let chunkSize = 0;
            this.cacheArray.find((chunk, i) => {
                if (chunkSize === 0) {
                    chunk.copy(this.chunk, 0, 0, this.byteLength);
                    chunkSize = Math.min(chunk.length, this.byteLength);
                    this.cacheArray[i] = chunk.slice(this.byteLength);
                } else {
                    let req = this.byteLength - chunkSize;
                    let tmpChunk;
                    tmpChunk = req < chunk.length ? chunk.slice(0, req) : chunk;
                    tmpChunk.copy(this.chunk, chunkSize);
                    chunkSize += tmpChunk.length;
                    this.cacheArray[i] = chunk.slice(req);
                }
                return chunkSize >= this.byteLength;
            });

            this.cacheSize -= this.byteLength;
            // remove empty buffers
            this.cacheArray = this.cacheArray.slice(
                0,
                this.cacheArray.findIndex(i => i.length),
            );
            this.playedBytes += this.byteLength;
            this.broadcast();
        }
        if (!this._finished && this._finishedLoading) {
            if (
                !this._emittedAlmostFinished &&
                this.cacheSize <
                    this.byteLength +
                        this.almostFinishedTrigger * this.sampleRate
            ) {
                this._emittedAlmostFinished = true;
                this.emit('almost-finished');
            } else if (this.cacheSize < this.byteLength) {
                this.finish();
            }
        }
    }
    public checkLag() {
        if (this._finishedLoading) {
            return false;
        }
        if (this._readablePaused) {
            return false;
        }
        return this.cachedTime < 1;
    }
    private frameTime(): number {
        const isNotOkay =
            this.finished ||
            this.paused ||
            this.checkLag() ||
            this.readable === undefined;
        if (isNotOkay) {
            console.log('Not okay ', this.checkLag());
            console.log('C: %d, r: %d', this.cachedTime, this.requiredTime);
        }
        return isNotOkay ? 500 : this.video ? 1000 / this.framerate : 10;
    }
    broadcast() {
        if (this.cacheSize < this.byteLength) {
            console.warn(
                'Cache size is less than byteLength',
                this.cacheSize,
                this.byteLength,
            );
        }
        try {
            if (this.video) {
                this.videoSource.onFrame({
                    data: new Uint8ClampedArray(this.chunk),
                    width: this.width,
                    height: this.height,
                });
            } else {
                const samples = new Int16Array(
                    new Uint8Array(this.chunk).buffer,
                );
                this.audioSource.onData({
                    bitsPerSample: this.bitsPerSample,
                    sampleRate: this.sampleRate,
                    channelCount: this.channelCount,
                    numberOfFrames: samples.length,
                    samples,
                });
            }
        } catch (error) {
            this.emit('error', error);
        }
    }
    currentPlayedTime(): number | undefined {
        if (this.readable === undefined || this.finished) {
            return undefined;
        } else {
            return Math.ceil(
                this.playedBytes /
                    this.byteLength /
                    (0.00001 / this.frameTime()),
            );
        }
    }
}
