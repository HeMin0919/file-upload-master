// Worker 内部如果要加载其他脚本，有一个专门的方法importScripts()。
self.importScripts("/spark-md5.min.js"); // 导入脚本


    /**
     * 在 worker 线程中，接受文件切片 fileChunkList，
     * 利用 FileReader 读取每个切片的 ArrayBuffer 并不断传入 spark-md5 中，
     * 每计算完一个切片通过 postMessage 向主线程发送一个进度事件，
     * 全部完成后将最终的 hash 发送给主线程
     */
// 生成文件 hash
self.onmessage = e => {
  const { fileChunkList } = e.data;
  const spark = new self.SparkMD5.ArrayBuffer();
  let percentage = 0;
  let count = 0;
  const loadNext = index => {
    const reader = new FileReader();
    reader.readAsArrayBuffer(fileChunkList[index].file);
    reader.onload = e => {
      count++;
      spark.append(e.target.result);
      if (count === fileChunkList.length) {
        self.postMessage({
          percentage: 100,
          hash: spark.end()// 结束 ArrayBuffer 流，获取计算后的文件 md5
        });
        self.close();// 关闭 worker 线程，线程如果不关闭，则会一直在后台运行着
      } else {
        percentage += 100 / fileChunkList.length;
        self.postMessage({
          percentage
        });
         // 递归计算下一个切片
        loadNext(count);
      }
    };
  };
  loadNext(0);
};
