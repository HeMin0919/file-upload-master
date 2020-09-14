<template>
  <div id="app">
    <div>
      <input
        type="file"
        :disabled="status !== Status.wait"
        @change="handleFileChange"
      />
      <el-button @click="handleUpload" :disabled="uploadDisabled"
        >上传</el-button>
      <el-button @click="handleResume" v-if="status === Status.pause"
        >恢复</el-button>
      <el-button
        v-else
        :disabled="status !== Status.uploading || !container.hash"
        @click="handlePause"
        >暂停</el-button
      >
    </div>
    <div>
      <div>计算文件 hash</div>
      <el-progress :percentage="hashPercentage"></el-progress>
      <div>总进度</div>
      <el-progress :percentage="fakeUploadPercentage"></el-progress>
    </div>
    <el-table :data="data">
      <el-table-column
        prop="hash"
        label="切片hash"
        align="center"
      ></el-table-column>
      <el-table-column label="大小(KB)" align="center" width="120">
        <template v-slot="{ row }">
          {{ row.size | transformByte }}
        </template>
      </el-table-column>
      <el-table-column label="进度" align="center">
        <template v-slot="{ row }">
          <el-progress
            :percentage="row.percentage"
            color="#909399"
          ></el-progress>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
const SIZE = 10 * 1024 * 1024; // 切片大小

const Status = {
  wait: "wait",
  pause: "pause",
  uploading: "uploading"
};

export default {
  name: "app",
  filters: {
    transformByte(val) {
      return Number((val / 1024).toFixed(0));
    }
  },
  data: () => ({
    Status,
    // 文件的内容
    container: {
      file: null,
      hash: "",
      worker: null
    },
    hashPercentage: 0,
    data: [], //要上传的文件信息
    requestList: [],
    status: Status.wait,
    // 当暂停时会取消 xhr 导致进度条后退
    // 为了避免这种情况，需要定义一个假的进度条
    fakeUploadPercentage: 0
  }),
  computed: {
    // 上传文件后，上传按钮禁用
    uploadDisabled() {
      return (
        !this.container.file ||
        [Status.pause, Status.uploading].includes(this.status)
      );
    },
    // 计算上传的百分比
    uploadPercentage() {
      if (!this.container.file || !this.data.length) return 0;
      console.log(this.data)
      const loaded = this.data
        .map(item => item.size * item.percentage)
        .reduce((acc, cur) => acc + cur);
      return parseInt((loaded / this.container.file.size).toFixed(2));
    }
  },
  watch: {
    uploadPercentage(now) {
      if (now > this.fakeUploadPercentage) {
        this.fakeUploadPercentage = now;
      }
    }
  },
  methods: {
    /**
     * 暂停按钮，当点击按钮时，
     * 调用保存在 requestList 中 xhr 的 abort 方法，即取消并清空所有正在上传的切片
     */
    handlePause() {
      this.status = Status.pause;
      this.resetData();
    },
    resetData() {
      this.requestList.forEach(xhr => xhr?.abort());
      this.requestList = [];
      if (this.container.worker) {
        this.container.worker.onmessage = null;
      }
    },
    // 恢复，先获取已上传的文件名和hash，然后调用上传切片方法
    async handleResume() {
      this.status = Status.uploading;
      const { uploadedList } = await this.verifyUpload(
        this.container.file.name,
        this.container.hash
      );
      await this.uploadChunks(uploadedList);
    },
    // xhr
    request({
      url,
      method = "post",
      data,
      headers = {},
      onProgress = e => e,
      requestList //将上传每个切片的 xhr 对象保存起来
    }) {
      return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        //XMLHttpRequest 原生支持上传进度的监听，只需要监听upload.onprogress
        xhr.upload.onprogress = onProgress;
        xhr.open(method, url);
        Object.keys(headers).forEach(key =>
          xhr.setRequestHeader(key, headers[key])
        );
        xhr.send(data);
        xhr.onload = e => {
          console.log(requestList)
          // 将请求成功的 xhr 从列表中删除
          if (requestList) {
            const xhrIndex = requestList.findIndex(item => item === xhr);
            requestList.splice(xhrIndex, 1);
          }
          resolve({
            data: e.target.response
          });
        };
        // 将当前 xhr 存入请求对象列表
        requestList?.push(xhr);
      });
    },
    // 生成文件切片
    createFileChunk(file, size = SIZE) {
      // 用于存储文件切片
      const fileChunkList = [];
      let cur = 0;
      while (cur < file.size) {
        fileChunkList.push({ file: file.slice(cur, cur + size) });
        cur += size;
      }
      console.log('文件切片',fileChunkList)
      return fileChunkList;
    },
    // 生成文件 hash（web-worker）
    /**
     * 在 worker 线程中，接受文件切片 fileChunkList，
     * 利用 FileReader 读取每个切片的 ArrayBuffer 并不断传入 spark-md5 中，
     * 每计算完一个切片通过 postMessage 向主线程发送一个进度事件，
     * 全部完成后将最终的 hash 发送给主线程
     */
    calculateHash(fileChunkList) {
      return new Promise(resolve => {
        // 主线程采用new命令，调用Worker()构造函数，新建一个 Worker 线程。
        this.container.worker = new Worker("/hash.js");
        //主线程调用worker.postMessage()方法，向 Worker 发消息
        this.container.worker.postMessage({ fileChunkList });
        // 主线程通过worker.onmessage指定监听函数，接收子线程发回来的消息
        this.container.worker.onmessage = e => {
          const { percentage, hash } = e.data;
          this.hashPercentage = percentage;
          if (hash) {
            resolve(hash);
          }
        };
      });
    },
    // 点击选择文件后调用
    handleFileChange(e) {
      const [file] = e.target.files;
      console.log(file)
      if (!file) return;
      this.resetData();
      console.log(this.$options.data())
      console.log(this.$data)

      Object.assign(this.$data, this.$options.data());// 通过给组件 $data 对象赋值来重置来重置整个 $data
      this.container.file = file;
    },

    // 点击上传按钮调用
    async handleUpload() {
      // debugger
      if (!this.container.file) return;
      this.status = Status.uploading;
      // 先生成切片
      const fileChunkList = this.createFileChunk(this.container.file);
      // 根据切片生成文件hash
      this.container.hash = await this.calculateHash(fileChunkList);

      // 判断文件是否上传过
      const { shouldUpload, uploadedList } = await this.verifyUpload(
        this.container.file.name,
        this.container.hash
      );
      if (!shouldUpload) {
        this.$message.success("秒传：上传成功");
        this.status = Status.wait;
        return;
      }

      this.data = fileChunkList.map(({ file }, index) => ({
        fileHash: this.container.hash,  //文件hash
        index,
        hash: this.container.hash + "-" + index, // 切片：文件hash + 数组下标
        chunk: file,
        size: file.size,
        percentage: uploadedList.includes(index) ? 100 : 0  //当前切片是否已上传过
      }));

      console.log(this.data)
      await this.uploadChunks(uploadedList);
    },
    // 上传切片，同时过滤已上传的切片
    async uploadChunks(uploadedList = []) {
      const requestList = this.data
        .filter(({ hash }) => !uploadedList.includes(hash))
        .map(({ chunk, hash, index }) => {
          const formData = new FormData();
          formData.append("chunk", chunk);
          formData.append("hash", hash);
          formData.append("filename", this.container.file.name);
          formData.append("fileHash", this.container.hash);
          return { formData, index };
        })
        .map(async ({ formData, index }) =>
          this.request({
            url: "http://localhost:3000",
            data: formData,
            onProgress: this.createProgressHandler(this.data[index]),
            requestList: this.requestList
          })
        );
      await Promise.all(requestList);  //并发切片
      // 之前上传的切片数量 + 本次上传的切片数量 = 所有切片数量时
      // 合并切片
      if (uploadedList.length + requestList.length === this.data.length) {
        await this.mergeRequest();
      }
    },
    // 通知服务端合并切片
    async mergeRequest() {
      await this.request({
        url: "http://localhost:3000/merge",
        headers: {
          "content-type": "application/json"
        },
        data: JSON.stringify({
          size: SIZE,
          fileHash: this.container.hash,
          filename: this.container.file.name
        })
      });
      this.$message.success("上传成功");
      this.status = Status.wait;
    },
    // 根据 hash 验证文件是否曾经已经被上传过
    // 没有才进行上传，向后端请求判断是否曾经上传过
    // 返回shouldUpload(true/false) 或  uploadedList(已上传的文件名)
    async verifyUpload(filename, fileHash) {
      const { data } = await this.request({
        url: "http://localhost:3000/verify",
        headers: {
          "content-type": "application/json"
        },
        data: JSON.stringify({
          filename,
          fileHash
        })
      });
      return JSON.parse(data);
    },
    // 用闭包保存每个 chunk 的进度数据
    createProgressHandler(item) {
      return e => {
        item.percentage = parseInt(String((e.loaded / e.total) * 100));
      };
    }
  }
};
</script>
