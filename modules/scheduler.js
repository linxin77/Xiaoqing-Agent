// 单一决策计时器；模型请求的看门狗由 Agent 管理，不产生第二个决策循环。
export class Scheduler {
    constructor(clock = globalThis) { this.clock = clock; this.timer = null; }
    cancel() { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
    at(time, callback) {
        this.cancel();
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            Promise.resolve().then(callback).catch(() => console.error('[Xiaoqing] 调度失败，请查看插件任务状态；不记录原始错误。'));
        }, Math.max(0, Math.min(2_147_483_647, time - this.clock.now())));
    }
}
