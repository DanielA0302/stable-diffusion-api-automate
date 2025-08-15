
import fetch from "node-fetch";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { Command } from "commander";
import chalk from "chalk";
import process from "process";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Global configuration
let config = {
  baseUrl: process.env.SD_WEBUI_URL || "http://localhost:7860",
  configsFile: process.env.CONFIGS_FILE || "prompts/configs.jsonl",
  outputDir: process.env.OUTPUT_DIR || "out",
  verbose: false,
  saveMeta: false,
  disableLogConfig: false,
  shouldExit: false
};

// Define TypeScript types
interface PayloadConfig {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  sampler_name: string;
  steps: number;
  cfg_scale: number;
  seed: number;
  batch_size: number;
  n_iter: number;
  hires_fix: boolean;
}

interface Txt2ImgResponse {
  images: string[];
  info?: string;
}

interface ProgressResponse {
  progress: number;
  eta_relative: number;
  state: {
    skipped: boolean;
    interrupted: boolean;
    job: string;
    job_count: number;
    job_timestamp: string;
    job_no: number;
    sampling_step: number;
    sampling_steps: number;
  };
  current_image?: string;
  textinfo?: string;
}

async function loadConfigs(): Promise<PayloadConfig[]> {
  const configContent = await readFile(config.configsFile, "utf-8");
  const configs: PayloadConfig[] = [];
  
  for (const line of configContent.trim().split("\n")) {
    if (line.trim()) {
      configs.push(JSON.parse(line) as PayloadConfig);
    }
  }
  
  return configs;
}

function createProgressBar(progress: number, width: number = 30): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  return `[${bar}] ${chalk.cyan((progress * 100).toFixed(1) + '%')}`;
}

async function waitForGenerationComplete(generationPromise: Promise<any>, expectedIterations: number = 1): Promise<void> {
  let isComplete = false;
  
  // Check if generation is complete
  generationPromise.then(() => {
    isComplete = true;
  }).catch(() => {
    isComplete = true;
  });
  
  while (!isComplete) {
    try {
      const res = await fetch(progressUrl);
      const progress = await res.json() as ProgressResponse;
      
      // Calculate current iteration and overall progress
      const currentJob = progress.state.job_no || 0;
      const totalJobs = progress.state.job_count || expectedIterations;
      const currentIter = Math.min(currentJob + 1, totalJobs);
      
      // Progress within current iteration
      const iterProgress = createProgressBar(progress.progress);
      
      // Overall progress across all iterations
      const overallProgress = totalJobs > 1 
        ? (currentJob + progress.progress) / totalJobs 
        : progress.progress;
      const overallBar = createProgressBar(overallProgress);
      
      const stepInfo = progress.state.sampling_steps > 0 
        ? ` Step ${progress.state.sampling_step}/${progress.state.sampling_steps}`
        : '';
      const eta = progress.eta_relative > 0 ? ` ETA: ${progress.eta_relative.toFixed(1)}s` : '';
      
      let progressLine;
      if (totalJobs > 1) {
        progressLine = `\r🔄 ${chalk.blue(`Iter ${currentIter}/${totalJobs}`)}: ${iterProgress}${chalk.yellow(stepInfo)} | ${chalk.magenta('Overall')}: ${overallBar}${chalk.cyan(eta)}`;
      } else {
        progressLine = `\r🔄 ${iterProgress}${chalk.yellow(stepInfo)}${chalk.cyan(eta)}`;
      }
      
      // Clear line and write progress
      process.stdout.write('\x1b[2K' + progressLine); // Clear entire line and write new content
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Check every 0.5 seconds for smoother updates
    } catch (err) {
      // Ignore progress check errors during generation
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Clear the progress line and show completion
  process.stdout.write('\x1b[2K\r');
  console.log("✅ Generation complete");
}

async function waitForServerReady(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(progressUrl);
      const progress = await res.json() as ProgressResponse;
      
      // Check if server is idle (no active jobs)
      if (progress.progress === 0 && !progress.state.job) {
        console.log("✅ Server is ready for next request");
        break;
      }
      
      console.log(`⏳ Server busy, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      console.warn("⚠️ Could not check server status, waiting 3 seconds...");
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function generateImages() {
  try {
    const configs = await loadConfigs();
    log(`Loaded ${configs.length} configurations from ${config.configsFile}`, 'verbose');
    
    // Create output directory with today's date
    const today = new Date().toISOString().split('T')[0]; // 2025-08-14 format
    const outputDir = join(config.outputDir, today);
    await mkdir(outputDir, { recursive: true });
    log(`Output directory: ${outputDir}`, 'verbose');
    
    for (let configIndex = 0; configIndex < configs.length; configIndex++) {
      // Check for graceful exit
      if (config.shouldExit) {
        log(`🛑 Graceful exit requested. Stopping after ${configIndex} configs.`, 'warning');
        break;
      }
      
      const currentConfig = configs[configIndex];
      const overallProgress = createProgressBar(configIndex / configs.length, 40);
      log(`\n📸 ${overallProgress} Config ${configIndex + 1}/${configs.length}`, 'info');
      
      // Show config details
      if (!config.disableLogConfig) {
        log(`📋 Config: ${JSON.stringify(currentConfig, null, 2)}`, 'verbose');
      }
      
      // Start generation request (don't await yet)
      const generationPromise = fetch(txt2imgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentConfig)
      });

      // Monitor progress while generation is running
      await waitForGenerationComplete(generationPromise, currentConfig.n_iter);
      
      // Get the result
      const res = await generationPromise;
      const data = await res.json() as Txt2ImgResponse;

      // Parse info to get actual seeds used
      let infoData: any = {};
      if (data.info) {
        try {
          infoData = JSON.parse(data.info);
        } catch (e) {
          console.warn("Could not parse info data");
        }
      }

      for (let i = 0; i < data.images.length; i++) {
        const imgBuffer = Buffer.from(data.images[i], "base64");
        
        const timestamp = Date.now();
        const actualSeed = infoData.seed ? infoData.seed + i : Math.floor(Math.random() * 1000000000);
        const filename = `${timestamp}-${actualSeed}.png`;
        const filePath = join(outputDir, filename);
        
        await writeFile(filePath, imgBuffer);
        log(`💾 Saved: ${filePath}`, 'success');
        
        // Save metadata if requested
        if (config.saveMeta) {
          const metaFilename = `${timestamp}-${actualSeed}.meta.json`;
          const metaFilePath = join(outputDir, metaFilename);
          const metadata = {
            config: currentConfig,
            response: {
              info: infoData,
              timestamp: new Date().toISOString(),
              filename: filename,
              seed: actualSeed
            }
          };
          await writeFile(metaFilePath, JSON.stringify(metadata, null, 2));
          log(`📋 Metadata saved: ${metaFilePath}`, 'verbose');
        }
      }

      log(`✅ Completed config ${configIndex + 1}/${configs.length} - Generated ${data.images.length} images`, 'success');

      // Wait for server to be ready before next request
      if (configIndex < configs.length - 1) {
        await waitForServerReady();
      }
    }
    
    // Final completion message
    const finalProgress = createProgressBar(1, 40);
    log(`\n🎉 ${finalProgress} All configs completed!`, 'success');
    log(`📁 Images saved to: ${outputDir}`, 'info');
  } catch (err) {
    log(`❌ Error generating images: ${err}`, 'error');
  }
}

// Setup CLI
const program = new Command();
program
  .name('sd-automate')
  .description('Stable Diffusion API automation tool')
  .version('1.0.0')
  .option('--configs-file <path>', 'Path to configs JSONL file', config.configsFile)
  .option('--output-dir <path>', 'Output directory for images', config.outputDir)
  .option('--base-url <url>', 'WebUI API base URL', config.baseUrl)
  .option('--save-meta', 'Save metadata files')
  .option('--disable-log-config', 'Disable config logging')
  .option('-v, --verbose', 'Verbose logging')
  .parse();

const options = program.opts();
config.configsFile = options.configsFile;
config.outputDir = options.outputDir;
config.baseUrl = options.baseUrl;
config.saveMeta = options.saveMeta;
config.disableLogConfig = options.disableLogConfig;
config.verbose = options.verbose;

// Update URLs with the final baseUrl
const txt2imgUrl = `${config.baseUrl}/sdapi/v1/txt2img`;
const progressUrl = `${config.baseUrl}/sdapi/v1/progress`;

// Setup keyboard handler for 'z' key
function setupKeyboardHandler() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('data', (key) => {
      const keyStr = key.toString();
      if (keyStr === 'z' || keyStr === 'Z') {
        console.log(chalk.yellow('\n🛑 Graceful exit requested. Will finish current config and exit...'));
        config.shouldExit = true;
      } else if (keyStr === '\u0003') { // Ctrl+C
        console.log(chalk.red('\n❌ Force exit'));
        process.exit(1);
      }
    });
  }
}

// Logging utilities
function log(message: string, level: 'info' | 'verbose' | 'success' | 'warning' | 'error' = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = config.verbose ? `[${timestamp}] ` : '';
  
  switch (level) {
    case 'verbose':
      if (config.verbose) {
        console.log(chalk.gray(`${prefix}${message}`));
      }
      break;
    case 'success':
      console.log(chalk.green(`${prefix}${message}`));
      break;
    case 'warning':
      console.log(chalk.yellow(`${prefix}${message}`));
      break;
    case 'error':
      console.log(chalk.red(`${prefix}${message}`));
      break;
    default:
      console.log(`${prefix}${message}`);
  }
}

setupKeyboardHandler();
log('🚀 Starting Stable Diffusion automation...', 'info');
log(`Press 'z' to gracefully exit after current config`, 'verbose');
generateImages();
