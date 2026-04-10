// PM2 Ecosystem Config — 서버 프로세스 관리
// 사용: pm2 start ecosystem.config.cjs
// 클러스터 모드로 CPU 코어 활용, LLM Worker 병렬 처리 강화

module.exports = {
  apps: [
    {
      name: 'graymar-server',
      script: 'dist/src/main.js',
      instances: 2,              // 2 인스턴스 (각각 3턴 동시 처리 → 총 6턴)
      exec_mode: 'cluster',      // 클러스터 모드
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      max_memory_restart: '512M',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // 로그
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
