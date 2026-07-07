import { useState, useEffect, useCallback, useRef } from 'react';
import comfyui, { modifyMaskWorkflow } from '../services/comfyui';
import { getBundledWorkflowPath } from '../config/workflowRegistry';

// Store the base workflow in memory after first load
let cachedWorkflows = {};

/**
 * Hook for interacting with ComfyUI
 */
export function useComfyUI() {
  const [isConnected, setIsConnected] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState({ value: 0, max: 100 });
  const [currentPromptId, setCurrentPromptId] = useState(null);
  const [error, setError] = useState(null);
  const [queueCount, setQueueCount] = useState(0);
  const [generationResult, setGenerationResult] = useState(null);
  
  // Use ref to track polling interval
  const pollingRef = useRef(null);

  // Track WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Track WebSocket attempt count to avoid spam
  const wsAttemptCount = useRef(0);
  
  // Check connection on mount
  const checkConnectionRef = useRef(null);
  const recheckConnection = useCallback(async () => {
    const fn = checkConnectionRef.current;
    if (typeof fn === 'function') {
      await fn();
    }
  }, []);

  useEffect(() => {
    const checkConnection = async () => {
      const connected = await comfyui.checkConnection();
      setIsConnected(connected);
      
      // Only try WebSocket a few times, then give up
      if (connected && !comfyui.isWebSocketConnected() && wsAttemptCount.current < 3) {
        try {
          wsAttemptCount.current++;
          await comfyui.connect();
          setWsConnected(true);
          console.log('WebSocket connected successfully');
        } catch (err) {
          setWsConnected(false);
          // Only log once
          if (!window._wsErrorLogged) {
            console.log('WebSocket connection failed, will use HTTP polling for progress');
            window._wsErrorLogged = true;
          }
        }
      } else if (connected && comfyui.isWebSocketConnected()) {
        setWsConnected(true);
      }
    };

    checkConnectionRef.current = checkConnection;
    checkConnection();
    
    // Check HTTP connection periodically, but don't spam WebSocket attempts
    // Use longer interval when WebSocket has failed multiple times
    const interval = setInterval(checkConnection, wsConnected ? 10000 : 30000);
    return () => clearInterval(interval);
  }, [wsConnected]);

  // Track which node is currently executing (for progress estimation)
  const [currentNode, setCurrentNode] = useState(null);
  const nodeProgressRef = useRef({ completed: 0, total: 0 });
  
  // Set up WebSocket event listeners
  useEffect(() => {
    const handleProgress = (data) => {
      // This is the actual step-by-step progress from ComfyUI
      console.log('Progress event:', data);
      if (data.promptId === currentPromptId || !currentPromptId) {
        // Calculate percentage
        const percent = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0;
        setProgress({ value: data.value, max: data.max, percent });
      }
    };

    const handleComplete = (data) => {
      console.log('Complete event:', data);
      if (data.promptId === currentPromptId) {
        // Set progress to 100% when complete
        setProgress({ value: 100, max: 100, percent: 100 });
      }
    };

    const handleExecuting = (data) => {
      // Track which node is being executed
      if (data.promptId === currentPromptId) {
        setCurrentNode(data.node);
        if (data.node) {
          nodeProgressRef.current.completed++;
          console.log(`Executing node: ${data.node} (${nodeProgressRef.current.completed} nodes completed)`);
        }
      }
    };

    const handleExecuted = (data) => {
      console.log('Node executed:', data.node, data.output);
      // If this is the SaveVideo node (75), the video is ready
      if (data.node === '75' && data.output?.videos) {
        console.log('Video output detected:', data.output);
      }
    };

    comfyui.on('progress', handleProgress);
    comfyui.on('complete', handleComplete);
    comfyui.on('executing', handleExecuting);
    comfyui.on('executed', handleExecuted);

    return () => {
      comfyui.off('progress', handleProgress);
      comfyui.off('complete', handleComplete);
      comfyui.off('executing', handleExecuting);
      comfyui.off('executed', handleExecuted);
    };
  }, [currentPromptId]);

  // Track if we've already processed the current result
  const processedPromptRef = useRef(null);

  // Poll for completion when generating
  useEffect(() => {
    if (!isGenerating || !currentPromptId) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const pollForCompletion = async () => {
      // Skip if we've already processed this prompt
      if (processedPromptRef.current === currentPromptId) {
        return;
      }

      try {
        const history = await comfyui.getHistory(currentPromptId);
        const promptHistory = history[currentPromptId];
        
        if (promptHistory) {
          // Check if there's an error
          if (promptHistory.status?.status_str === 'error') {
            processedPromptRef.current = currentPromptId;
            setError('Generation failed');
            setIsGenerating(false);
            setProgress({ value: 0, max: 100 });
            return;
          }
          
          // Check if outputs are available (generation complete)
          const outputs = promptHistory.outputs;
          if (outputs && Object.keys(outputs).length > 0) {
            // Mark as processed immediately to prevent duplicate processing
            processedPromptRef.current = currentPromptId;
            
            // Stop polling immediately
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            
            console.log('Generation complete, full history:', promptHistory);
            console.log('Outputs:', outputs);
            console.log('Available output nodes:', Object.keys(outputs));
            
            // Find video output - check multiple possible node IDs
            let videoData = null;
            
            // Log the full structure of node 75 to see what we're dealing with
            console.log('Node 75 full output:', JSON.stringify(outputs['75'], null, 2));
            
            // Try node 75 first (SaveVideo) - check various possible keys
            const node75 = outputs['75'];
            if (node75) {
              // Check for videos array
              if (node75.videos?.[0]) {
                videoData = node75.videos[0];
                console.log('Found video in node 75 videos:', videoData);
              }
              // Check for gifs array (some nodes output as gifs)
              else if (node75.gifs?.[0]) {
                videoData = node75.gifs[0];
                console.log('Found gif in node 75:', videoData);
              }
              // Check for images array (fallback)
              else if (node75.images?.[0]) {
                videoData = node75.images[0];
                console.log('Found image in node 75:', videoData);
              }
              // Check if it's directly an array
              else if (Array.isArray(node75) && node75[0]) {
                videoData = node75[0];
                console.log('Found direct array in node 75:', videoData);
              }
            }
            
            // Also check all other nodes for any video/gif output
            if (!videoData) {
              for (const nodeId of Object.keys(outputs)) {
                const nodeOutput = outputs[nodeId];
                console.log(`Checking node ${nodeId}:`, Object.keys(nodeOutput));
                
                if (nodeOutput.videos?.[0]) {
                  videoData = nodeOutput.videos[0];
                  console.log(`Found video in node ${nodeId}:`, videoData);
                  break;
                }
                if (nodeOutput.gifs?.[0]) {
                  videoData = nodeOutput.gifs[0];
                  console.log(`Found gif in node ${nodeId}:`, videoData);
                  break;
                }
                if (nodeOutput.images?.[0]) {
                  // Only use images if they look like videos (mp4, webm, etc)
                  const img = nodeOutput.images[0];
                  if (img.filename?.match(/\.(mp4|webm|gif)$/i)) {
                    videoData = img;
                    console.log(`Found video-like image in node ${nodeId}:`, videoData);
                    break;
                  }
                }
              }
            }
            
            if (videoData) {
              const url = comfyui.getMediaUrl(
                videoData.filename, 
                videoData.subfolder || '', 
                videoData.type || 'output'
              );
              console.log('Constructed video URL:', url);
              
              const result = {
                type: 'video',
                url: url,
                filename: videoData.filename,
                subfolder: videoData.subfolder
              };
              console.log('Setting generation result:', result);
              setGenerationResult(result);
            } else {
              console.warn('No video found in outputs');
            }
            
            setIsGenerating(false);
            setProgress({ value: 100, max: 100 });
          }
        }
      } catch (err) {
        console.error('Error polling for completion:', err);
      }
    };

    // Poll every 2 seconds
    pollingRef.current = setInterval(pollForCompletion, 2000);
    
    // Also poll immediately
    pollForCompletion();

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isGenerating, currentPromptId]);

  // Update queue count periodically
  useEffect(() => {
    const updateQueue = async () => {
      if (isConnected) {
        const status = await comfyui.getQueueStatus();
        setQueueCount(status.queue_pending?.length || 0);
      }
    };

    updateQueue();
    const interval = setInterval(updateQueue, 2000);
    return () => clearInterval(interval);
  }, [isConnected]);

  /**
   * Legacy GeneratePanel entrypoint retained for backward compatibility.
   * Active generation now runs through GenerateWorkspace queue workflows.
   */
  const generateVideo = useCallback(async () => {
    if (!isConnected) {
      setError('ComfyUI is not connected');
      return null;
    }
    setError('Legacy single-click video generation has been retired. Use Generate workflows instead.');
    return null;
  }, [isConnected]);

  /**
   * Get the result of a generation
   */
  const getResult = useCallback(async (promptId) => {
    try {
      const history = await comfyui.getHistory(promptId);
      const outputs = history[promptId]?.outputs;
      
      if (!outputs) return null;

      // Find the SaveVideo node output (node 75)
      const videoOutput = outputs['75'];
      if (videoOutput?.videos?.[0]) {
        const video = videoOutput.videos[0];
        return {
          type: 'video',
          url: comfyui.getMediaUrl(video.filename, video.subfolder || '', video.type || 'output'),
          filename: video.filename
        };
      }

      return null;
    } catch (err) {
      console.error('Error getting result:', err);
      return null;
    }
  }, []);

  /**
   * Cancel the current generation
   */
  const cancel = useCallback(async () => {
    await comfyui.interrupt();
    setIsGenerating(false);
    setProgress({ value: 0, max: 100 });
    setCurrentPromptId(null);
  }, []);

  /**
   * Clear the current result
   */
  const clearResult = useCallback(() => {
    setGenerationResult(null);
  }, []);

  // ============================================
  // MASK GENERATION
  // ============================================
  
  const [maskResult, setMaskResult] = useState(null);
  const maskPromptIdRef = useRef(null);
  
  /**
   * Generate a mask from an image/video using SAM3 text prompt
   * @param {Object} options - Generation options
   * @param {Object} options.asset - The source asset (video or image)
   * @param {string} options.textPrompt - Text description of what to segment
   * @param {number} options.scoreThreshold - Detection sensitivity (default 0.04)
   * @param {FileSystemDirectoryHandle} options.projectHandle - Project handle for saving
   */
  const generateMask = useCallback(async (options) => {
    const { asset, textPrompt, scoreThreshold = 0.04, projectHandle } = options;
    
    if (!isConnected) {
      setError('ComfyUI is not connected');
      return null;
    }
    
    if (!asset || !asset.url) {
      setError('Invalid asset');
      return null;
    }

    setIsGenerating(true);
    setError(null);
    setProgress({ value: 0, max: 100, percent: 0 });
    setMaskResult(null);
    setCurrentNode(null);
    nodeProgressRef.current = { completed: 0, total: 0 };
    processedPromptRef.current = null;

    try {
      // Step 1: Get the file blob from the asset URL
      console.log('Fetching asset for upload:', asset.url);
      console.log('Asset info:', { name: asset.name, type: asset.type, mimeType: asset.mimeType });
      
      const response = await fetch(asset.url);
      if (!response.ok) {
        throw new Error('Failed to fetch asset file');
      }
      const blob = await response.blob();
      
      // Get the original file extension from the asset name
      let extension = '';
      let mimeType = blob.type || asset.mimeType;
      
      if (asset.name) {
        const nameParts = asset.name.split('.');
        if (nameParts.length > 1) {
          extension = '.' + nameParts[nameParts.length - 1].toLowerCase();
        }
      }
      
      // If no extension from name, derive from mime type
      if (!extension) {
        const mimeToExt = {
          'image/jpeg': '.jpg',
          'image/jpg': '.jpg',
          'image/png': '.png',
          'image/webp': '.webp',
          'image/gif': '.gif',
          'video/mp4': '.mp4',
          'video/webm': '.webm',
          'video/quicktime': '.mov',
        };
        extension = mimeToExt[mimeType] || '.png';
      }
      
      // For VHS_LoadVideo compatibility, convert webp to png
      // VHS_LoadVideo doesn't natively support webp in many installations
      let file;
      let filename;
      
      if (extension === '.webp') {
        console.log('Converting webp to png for VHS_LoadVideo compatibility...');
        // Create a canvas to convert webp to png
        const img = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        await new Promise((resolve, reject) => {
          img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            resolve();
          };
          img.onerror = reject;
          img.src = URL.createObjectURL(blob);
        });
        
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        extension = '.png';
        mimeType = 'image/png';
        
        filename = `velorn_input_${Date.now()}${extension}`;
        console.log('Converted to PNG. Creating file:', filename);
        file = new File([pngBlob], filename, { type: mimeType });
      } else {
        filename = `velorn_input_${Date.now()}${extension}`;
        console.log('Creating file with extension:', extension, 'mimeType:', mimeType);
        file = new File([blob], filename, { type: mimeType });
      }
      
      // Step 2: Upload the file to ComfyUI
      console.log('Uploading file to ComfyUI:', filename);
      const uploadResult = await comfyui.uploadFile(file);
      console.log('Upload result:', uploadResult);
      
      // Step 3: Load the mask workflow if not cached
      if (!cachedWorkflows['mask-generation']) {
        const workflowResponse = await fetch(getBundledWorkflowPath('mask_generation_text_prompt.json'));
        if (!workflowResponse.ok) {
          throw new Error('Failed to load mask workflow');
        }
        cachedWorkflows['mask-generation'] = await workflowResponse.json();
      }

      const baseWorkflow = cachedWorkflows['mask-generation'];
      
      // Step 4: Modify workflow with our parameters
      const outputPrefix = `VelornMask_${Date.now()}`;
      const workflow = modifyMaskWorkflow(baseWorkflow, {
        inputFilename: uploadResult.name,
        textPrompt: textPrompt,
        outputPrefix: outputPrefix,
        scoreThreshold: scoreThreshold,
        frameIdx: 0,
      });

      console.log('Queueing mask workflow with text prompt:', textPrompt);
      console.log('Modified workflow node 8 (video input):', workflow['8']?.inputs);
      console.log('Modified workflow node 12 (SAM3 segmentation):', workflow['12']?.inputs);

      // Step 5: Queue the prompt
      const promptId = await comfyui.queuePrompt(workflow);
      console.log('Got mask prompt ID:', promptId);
      setCurrentPromptId(promptId);
      maskPromptIdRef.current = promptId;

      // Step 6: Set up a custom polling for mask results
      // The mask workflow outputs to node 5 (SaveImage)
      let pollingStopped = false;

      const buildMaskResultFromImages = (images) => {
        if (!images || images.length === 0) return null;
        const firstImage = images[0];
        const maskUrl = comfyui.getMediaUrl(
          firstImage.filename,
          firstImage.subfolder || '',
          firstImage.type || 'output'
        );

        return {
          sourceAssetId: asset.id,
          url: maskUrl,
          frameCount: images.length,
          width: asset.settings?.width,
          height: asset.settings?.height,
          maskFrames: images.map(img => ({
            filename: img.filename,
            url: comfyui.getMediaUrl(img.filename, img.subfolder || '', img.type || 'output'),
            subfolder: img.subfolder,
          })),
        };
      };

      const extractImagesFromOutputs = (outputs) => {
        if (!outputs || Object.keys(outputs).length === 0) return null;
        if (outputs['5']?.images && outputs['5'].images.length > 0) {
          return outputs['5'].images;
        }
        for (const nodeId of Object.keys(outputs)) {
          const nodeOutput = outputs[nodeId];
          if (nodeOutput?.images && nodeOutput.images.length > 0) {
            return nodeOutput.images;
          }
        }
        return null;
      };

      const tryResolveFromFullHistory = async () => {
        try {
          const history = await comfyui.getHistory();
          const promptKeys = Object.keys(history || {});
          for (const key of promptKeys) {
            const promptHistory = history[key];
            const images = extractImagesFromOutputs(promptHistory?.outputs);
            if (!images || images.length === 0) continue;
            const matching = images.filter(img => img.filename?.startsWith(outputPrefix));
            if (matching.length > 0) {
              return matching;
            }
          }
        } catch (err) {
          console.warn('Failed to resolve mask from full history:', err);
        }
        return null;
      };
      
      const pollMaskCompletion = async () => {
        if (pollingStopped) return true;
        
        try {
          const history = await comfyui.getHistory(promptId);
          const promptHistory = history[promptId];
          
          if (promptHistory) {
            // Check for errors
            if (promptHistory.status?.status_str === 'error') {
              console.error('Mask generation failed:', promptHistory.status);
              // Extract the actual Python error from ComfyUI's `execution_error`
              // message so the user sees something actionable instead of just
              // "Mask generation failed". The messages array is a sequence of
              // [event_type, payload] tuples; only `execution_error` has the
              // exception details we want.
              const messages = promptHistory.status?.messages || [];
              const errorMsg = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error');
              if (errorMsg && errorMsg[1]) {
                const { node_type: nodeType, exception_type: excType, exception_message: excMsg } = errorMsg[1];
                const cleanMsg = String(excMsg || '').trim().split('\n')[0] || 'Unknown error';
                // Friendly single-liner for common error classes; fall back to
                // showing the node that blew up so the user can report it.
                setError(`Mask generation failed at ${nodeType || 'node'}: ${cleanMsg}`);
              } else {
                setError('Mask generation failed');
              }
              setIsGenerating(false);
              pollingStopped = true;
              return true; // Stop polling
            }
            
            // Check for outputs
            const outputs = promptHistory.outputs;
            if (outputs && Object.keys(outputs).length > 0) {
              console.log('Mask generation complete, outputs:', outputs);
              console.log('Available output nodes:', Object.keys(outputs));
              
              const images = extractImagesFromOutputs(outputs);
              if (images && images.length > 0) {
                const result = buildMaskResultFromImages(images);
                if (result) {
                  console.log('Setting mask result:', result);
                  pollingStopped = true;
                  setProgress({ value: 100, max: 100, percent: 100 });
                  setIsGenerating(false);
                  setMaskResult(result);
                  return true; // Stop polling
                }
              } else {
                console.log('Outputs found but no images yet, continuing to poll...');
              }
            }
          }
          return false; // Continue polling
        } catch (err) {
          console.error('Error polling mask completion:', err);
          return false; // Continue polling
        }
      };

      // Start polling for mask results
      const maskPollInterval = setInterval(async () => {
        const done = await pollMaskCompletion();
        if (done) {
          clearInterval(maskPollInterval);
        }
      }, 2000);

      // Initial poll
      pollMaskCompletion();
      
      // Safety timeout - stop polling after 5 minutes
      setTimeout(() => {
        if (!pollingStopped) {
          console.warn('Mask generation timed out after 5 minutes');
          clearInterval(maskPollInterval);
          pollingStopped = true;
          // Try to recover by scanning full history for our output prefix
          (async () => {
            const recoveredImages = await tryResolveFromFullHistory();
            if (recoveredImages && recoveredImages.length > 0) {
              const result = buildMaskResultFromImages(recoveredImages);
              if (result) {
                setProgress({ value: 100, max: 100, percent: 100 });
                setIsGenerating(false);
                setMaskResult(result);
                return;
              }
            }
            setError('Mask generation timed out');
            setIsGenerating(false);
          })();
        }
      }, 5 * 60 * 1000);

      return promptId;
    } catch (err) {
      console.error('Mask generation error:', err);
      setError(err.message);
      setIsGenerating(false);
      return null;
    }
  }, [isConnected]);

  /**
   * Clear the mask result
   */
  const clearMaskResult = useCallback(() => {
    setMaskResult(null);
    maskPromptIdRef.current = null;
  }, []);

  return {
    isConnected,
    isGenerating,
    progress,
    error,
    queueCount,
    generationResult,
    generateVideo,
    getResult,
    cancel,
    clearResult,
    wsConnected,  // Expose WebSocket connection status
    currentNode,  // Expose which node is executing
    recheckConnection,  // Force an immediate HTTP/WebSocket re-check (e.g. after launcher state change)
    // Mask generation
    generateMask,
    maskResult,
    clearMaskResult,
  };
}

export default useComfyUI;
