module.exports = {
  apps: [
    {
      name: "perp-trader-grid",
      // 构建输出由 esbuild 生成，入口与实际文件路径保持一致
      script: "dist/index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
