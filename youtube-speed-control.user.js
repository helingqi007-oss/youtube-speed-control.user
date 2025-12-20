// ==UserScript==
// @name         YouTube 倍速增强 + 新标签页打开
// @namespace    Tampermonkey Scripts
// @match        *://www.youtube.com/*
// @grant        none
// @version      1.6
// @author       
// @description  长按快捷键快速倍速播放（Z/Ctrl 2倍速，右方向键 3倍速）。视频控制栏添加倍速切换按钮，支持自定义倍速设置。YouTube 链接强制新标签页打开。
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    // 倍速相关配置
    const PRESET_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]; // 预设倍速，不可删除
    let SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]; // 当前显示的倍速
    let CUSTOM_SPEEDS = []; // 用户自定义添加的倍速
    const SPEED_KEY_Z = 2.0;
    const SPEED_KEY_CTRL = 2.0;
    const SPEED_KEY_RIGHT = 3.0;

    // 新标签页打开链接相关配置
    const YOUTUBE_LINK_PATTERNS = ['/watch', '/channel', '/user', '/playlist', '/shorts'];

    // ==================== 功能开关配置 ====================
    // 是否启用"点击链接在新标签页打开"功能
    const ENABLE_NEW_TAB_LINKS = true;
    // 是否启用"新标签页视频自动暂停"功能
    const ENABLE_AUTO_PAUSE_VIDEO = true;

    // ==================== 状态变量 ====================
    let isPressing = false;
    let originalSpeed = 1.0;
    let overlayDiv = null;
    let currentKey = null;
    let longPressTimer = null;
    let isLongPress = false;
    let keyDownTime = 0; // 记录按下时间
    const LONG_PRESS_DELAY = 200; // 长按判定时间（毫秒）
    const SEEK_SECONDS = 5; // 短按快进秒数（与YouTube默认一致）

    // Ctrl键专用状态追踪（解决Ctrl键keyup事件可能丢失的问题）
    let ctrlKeyState = {
        isDown: false,
        originalSpeed: 1.0,
        checkInterval: null
    };

    // ==================== 工具函数 ====================
    function getVideo() {
        return document.querySelector('video');
    }

    function getPlayer() {
        return document.querySelector('#movie_player');
    }

    // ==================== 新标签页打开链接功能 ====================
    function isYouTubeLink(url) {
        return url.includes('youtube.com') || url.startsWith('/') || url.startsWith('https://youtu.be/');
    }

    function shouldOpenInNewTab(url) {
        return YOUTUBE_LINK_PATTERNS.some(pattern => url.includes(pattern));
    }

    // 获取视频ID（从URL中提取v参数）
    function getVideoIdFromUrl(url) {
        try {
            const urlObj = new URL(url, window.location.origin);
            return urlObj.searchParams.get('v');
        } catch (e) {
            return null;
        }
    }

    // 检查是否是当前视频的章节链接（同一视频，只是时间点不同）
    function isChapterLink(href) {
        const currentVideoId = getVideoIdFromUrl(window.location.href);
        const targetVideoId = getVideoIdFromUrl(href);

        // 如果目标链接和当前页面是同一个视频，则认为是章节跳转
        if (currentVideoId && targetVideoId && currentVideoId === targetVideoId) {
            return true;
        }
        return false;
    }

    // 检查点击是否来自播放列表面板中的视频项
    function isPlaylistPanelVideoClick(anchor) {
        // 检查祖先元素是否包含播放列表视频渲染器组件
        // ytd-playlist-panel-video-renderer 是播放列表面板中视频项的容器
        const playlistVideoRenderer = anchor.closest('ytd-playlist-panel-video-renderer');
        if (playlistVideoRenderer) {
            return true;
        }

        // 也检查 ytd-playlist-video-renderer（用于播放列表页面）
        const playlistPageRenderer = anchor.closest('ytd-playlist-video-renderer');
        if (playlistPageRenderer) {
            return true;
        }

        return false;
    }

    // 检查点击是否来自缩略图悬浮操作按钮（如"添加到队列"、"添加到播放列表"等）
    function isThumbnailHoverAction(element) {
        // 检查是否点击了 hover-overlays 区域内的元素（包含"稍后观看"和"添加到播放列表"按钮）
        const hoverOverlays = element.closest('#hover-overlays');
        if (hoverOverlays) {
            return true;
        }

        // 检查是否点击了 mouseover-overlay 区域
        const mouseoverOverlay = element.closest('#mouseover-overlay');
        if (mouseoverOverlay) {
            return true;
        }

        // 检查是否是 ytd-thumbnail-overlay-toggle-button-renderer 组件（稍后观看/添加到播放列表按钮）
        const overlayToggleButton = element.closest('ytd-thumbnail-overlay-toggle-button-renderer');
        if (overlayToggleButton) {
            return true;
        }

        return false;
    }

    function handleLinkClick(event) {
        // 如果未启用新标签页打开功能，直接返回
        if (!ENABLE_NEW_TAB_LINKS) return;

        if (event.ctrlKey || event.metaKey) return;

        const anchor = event.target.closest('a');
        if (!anchor || !anchor.href) return;

        // 如果是章节链接，不拦截，让其正常跳转时间点
        if (isChapterLink(anchor.href)) {
            return;
        }

        // 如果是播放列表面板中的视频点击，不拦截，让其在当前页面切换视频
        if (isPlaylistPanelVideoClick(anchor)) {
            return;
        }

        // 如果是缩略图悬浮操作按钮（如"添加到队列"、"添加到播放列表"），不拦截
        if (isThumbnailHoverAction(event.target)) {
            return;
        }

        if (isYouTubeLink(anchor.href) && shouldOpenInNewTab(anchor.href)) {
            event.preventDefault();
            event.stopPropagation();
            // Open the link in a new tab
            window.open(anchor.href, '_blank');
        }
    }

    // 页面加载时暂停视频
    function pauseVideoOnLoad() {
        // 如果未启用自动暂停功能，直接返回
        if (!ENABLE_AUTO_PAUSE_VIDEO) return;

        let video = document.querySelector('video');
        if (video) {
            video.pause();
        } else {
            // If video is not immediately found, try again after a short delay
            setTimeout(pauseVideoOnLoad, 100);
        }
    }

    // ==================== 倍速提示覆盖层 ====================
    function showOverlay(speed) {
        const player = getPlayer();
        if (!player) return;

        if (!overlayDiv) {
            overlayDiv = document.createElement('div');
            overlayDiv.id = 'yt-speed-overlay';
            overlayDiv.style.cssText = `
                position: absolute;
                top: 10%;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.75);
                color: #fff;
                padding: 12px 28px;
                border-radius: 30px;
                font-size: 20px;
                font-weight: 600;
                z-index: 9999;
                pointer-events: none;
                font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif;
                backdrop-filter: blur(4px);
            `;
            player.appendChild(overlayDiv);
        }
        overlayDiv.textContent = `${speed}x ▶▶`;
        overlayDiv.style.display = 'block';
    }

    function hideOverlay() {
        if (overlayDiv) {
            overlayDiv.style.display = 'none';
        }
    }

    // ==================== 键盘事件处理 ====================
    function handleKeyDown(e) {
        // 检查任意按键事件中的ctrlKey属性，用于检测Ctrl键是否真的还在按下
        if (ctrlKeyState.isDown && !e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight') {
            // Ctrl键状态标记为按下，但实际事件中ctrlKey为false，说明Ctrl键已松开但keyup事件丢失
            console.log('[YouTube倍速] 检测到Ctrl键状态不一致，强制恢复');
            const video = getVideo();
            if (video && video.playbackRate === SPEED_KEY_CTRL) {
                video.playbackRate = ctrlKeyState.originalSpeed;
            }
            ctrlKeyState.isDown = false;
            if (ctrlKeyState.checkInterval) {
                clearInterval(ctrlKeyState.checkInterval);
                ctrlKeyState.checkInterval = null;
            }
            isPressing = false;
            isLongPress = false;
            currentKey = null;
            hideOverlay();
            updateSpeedHighlight();
        }

        if (e.code !== 'KeyZ' && e.code !== 'ControlLeft' && e.code !== 'ControlRight' && e.code !== 'ArrowRight') return;

        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Z键保持原有行为：立即触发倍速
        if (e.code === 'KeyZ') {
            // 阻止默认行为
            e.preventDefault();
            e.stopPropagation();

            if (isPressing) return;

            const video = getVideo();
            if (!video) return;

            isPressing = true;
            isLongPress = true;
            currentKey = e.code;
            originalSpeed = video.playbackRate;
            console.log('[YouTube倍速] Z键按下，记录原始速度:', originalSpeed, '当前状态:', { isPressing, isLongPress, currentKey });

            video.playbackRate = SPEED_KEY_Z;
            showOverlay(SPEED_KEY_Z);
            updateSpeedHighlight();
            return;
        }

        // Ctrl键（左或右）：立即触发倍速
        if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
            // 阻止默认行为，避免浏览器快捷键干扰
            e.preventDefault();
            e.stopPropagation();

            if (isPressing) return;

            const video = getVideo();
            if (!video) return;

            isPressing = true;
            isLongPress = true;
            currentKey = e.code;
            originalSpeed = video.playbackRate;

            // 设置Ctrl键状态
            ctrlKeyState.isDown = true;
            ctrlKeyState.originalSpeed = video.playbackRate;

            console.log('[YouTube倍速] Ctrl键按下，记录原始速度:', originalSpeed, '当前状态:', { isPressing, isLongPress, currentKey });

            video.playbackRate = SPEED_KEY_CTRL;
            showOverlay(SPEED_KEY_CTRL);
            updateSpeedHighlight();

            // 启动轮询检查Ctrl键是否松开（兜底机制）
            if (ctrlKeyState.checkInterval) {
                clearInterval(ctrlKeyState.checkInterval);
            }
            let checkCount = 0;
            ctrlKeyState.checkInterval = setInterval(() => {
                const video = getVideo();
                if (!video) return;

                checkCount++;

                // 如果视频速度还是快进速度，检查Ctrl键是否真的还在按下
                if (ctrlKeyState.isDown && video.playbackRate === SPEED_KEY_CTRL) {
                    // 每秒输出一次日志（10次检查 = 1秒）
                    if (checkCount % 10 === 0) {
                        console.log('[YouTube倍速] Ctrl键轮询检查中...', checkCount / 10, '秒');
                    }

                    // 如果超过5秒还在快进状态，可能是keyup事件丢失，强制恢复
                    if (checkCount > 50) {
                        console.log('[YouTube倍速] Ctrl键超时（5秒），强制恢复速度');
                        video.playbackRate = ctrlKeyState.originalSpeed;
                        ctrlKeyState.isDown = false;
                        clearInterval(ctrlKeyState.checkInterval);
                        ctrlKeyState.checkInterval = null;
                        isPressing = false;
                        isLongPress = false;
                        currentKey = null;
                        hideOverlay();
                        updateSpeedHighlight();
                    }
                } else if (!ctrlKeyState.isDown) {
                    // Ctrl键已松开，清除定时器
                    clearInterval(ctrlKeyState.checkInterval);
                    ctrlKeyState.checkInterval = null;
                }
            }, 100);

            return;
        }

        // 右方向键：使用长按判定（先阻止，后补偿策略）
        if (e.code === 'ArrowRight') {
            // 始终阻止默认行为，避免触发YouTube原生快进
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // 如果已经在长按状态，直接返回
            if (isPressing && isLongPress) {
                return;
            }

            // 如果定时器已存在（正在等待长按判定），直接返回
            if (longPressTimer) {
                return;
            }

            const video = getVideo();
            if (!video) return;

            // 记录当前状态和按下时间
            currentKey = e.code;
            originalSpeed = video.playbackRate;
            keyDownTime = Date.now();

            // 启动长按判定定时器
            longPressTimer = setTimeout(() => {
                // 达到长按时间，触发倍速播放
                isPressing = true;
                isLongPress = true;
                longPressTimer = null;
                console.log('[YouTube倍速] 右方向键长按触发，记录的原始速度:', originalSpeed);

                video.playbackRate = SPEED_KEY_RIGHT;
                showOverlay(SPEED_KEY_RIGHT);
                updateSpeedHighlight();
            }, LONG_PRESS_DELAY);
        }
    }

    function handleKeyUp(e) {
        // 检查任意按键松开事件中的ctrlKey属性
        if (ctrlKeyState.isDown && !e.ctrlKey) {
            // Ctrl键已经不在按下状态了
            console.log('[YouTube倍速] 通过keyup事件检测到Ctrl键已松开');
            const video = getVideo();
            if (video && video.playbackRate === SPEED_KEY_CTRL) {
                video.playbackRate = ctrlKeyState.originalSpeed;
                console.log('[YouTube倍速] 恢复速度到:', ctrlKeyState.originalSpeed);
            }
            ctrlKeyState.isDown = false;
            if (ctrlKeyState.checkInterval) {
                clearInterval(ctrlKeyState.checkInterval);
                ctrlKeyState.checkInterval = null;
            }
            isPressing = false;
            isLongPress = false;
            currentKey = null;
            hideOverlay();
            updateSpeedHighlight();
        }

        if (e.code !== 'KeyZ' && e.code !== 'ControlLeft' && e.code !== 'ControlRight' && e.code !== 'ArrowRight') return;

        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Z键松开处理
        if (e.code === 'KeyZ') {
            // 阻止默认行为
            e.preventDefault();
            e.stopPropagation();

            console.log('[YouTube倍速] Z键松开事件触发', {
                isPressing,
                isLongPress,
                currentKey,
                originalSpeed
            });

            const video = getVideo();
            if (!video) {
                console.log('[YouTube倍速] 警告：找不到video元素');
                return;
            }

            console.log('[YouTube倍速] 当前视频速度:', video.playbackRate);

            if (isPressing && currentKey === 'KeyZ') {
                video.playbackRate = originalSpeed;
                console.log('[YouTube倍速] Z键松开，恢复速度:', originalSpeed);
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else if (currentKey === 'KeyZ') {
                // 兜底处理
                if (video.playbackRate === SPEED_KEY_Z) {
                    video.playbackRate = originalSpeed;
                    console.log('[YouTube倍速] Z键松开（兜底），恢复速度:', originalSpeed);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else {
                console.log('[YouTube倍速] 所有条件都不满足，强制恢复速度');
                // 强制恢复
                if (video.playbackRate === SPEED_KEY_Z) {
                    video.playbackRate = originalSpeed;
                    console.log('[YouTube倍速] 强制恢复速度:', originalSpeed);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            }
            return;
        }

        // Ctrl键（左或右）松开处理
        if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
            // 阻止默认行为
            e.preventDefault();
            e.stopPropagation();

            console.log('[YouTube倍速] Ctrl键松开事件触发', {
                code: e.code,
                isPressing,
                isLongPress,
                currentKey,
                originalSpeed,
                ctrlKeyState
            });

            // 清除轮询定时器
            if (ctrlKeyState.checkInterval) {
                clearInterval(ctrlKeyState.checkInterval);
                ctrlKeyState.checkInterval = null;
            }

            // 标记Ctrl键已松开
            ctrlKeyState.isDown = false;

            const video = getVideo();
            if (!video) {
                console.log('[YouTube倍速] 警告：找不到video元素');
                return;
            }

            console.log('[YouTube倍速] 当前视频速度:', video.playbackRate);

            // 使用ctrlKeyState中保存的原始速度
            const speedToRestore = ctrlKeyState.originalSpeed || originalSpeed;

            if (isPressing && (currentKey === 'ControlLeft' || currentKey === 'ControlRight')) {
                video.playbackRate = speedToRestore;
                console.log('[YouTube倍速] Ctrl键松开，恢复速度:', speedToRestore);
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else if (currentKey === 'ControlLeft' || currentKey === 'ControlRight') {
                // 兜底处理
                if (video.playbackRate === SPEED_KEY_CTRL) {
                    video.playbackRate = speedToRestore;
                    console.log('[YouTube倍速] Ctrl键松开（兜底），恢复速度:', speedToRestore);
                } else {
                    console.log('[YouTube倍速] 兜底条件不满足，当前速度:', video.playbackRate, '期望速度:', SPEED_KEY_CTRL);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else {
                console.log('[YouTube倍速] 所有条件都不满足，强制恢复速度');
                // 强制恢复：如果当前是快进速度，无论什么状态都恢复
                if (video.playbackRate === SPEED_KEY_CTRL) {
                    video.playbackRate = speedToRestore;
                    console.log('[YouTube倍速] 强制恢复速度:', speedToRestore);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            }
            return;
        }

        // 右方向键松开处理
        if (e.code === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('[YouTube倍速] 右方向键松开事件触发', {
                isPressing,
                isLongPress,
                currentKey,
                originalSpeed,
                hasTimer: !!longPressTimer
            });

            // 如果定时器还在运行，说明是短按
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                currentKey = null;
                originalSpeed = 1.0; // 重置原始速度
                console.log('[YouTube倍速] 短按右方向键，执行快进');

                // 手动执行快进操作（补偿被阻止的默认行为）
                const video = getVideo();
                if (video) {
                    video.currentTime = Math.min(video.currentTime + SEEK_SECONDS, video.duration);
                }
                return;
            }

            const video = getVideo();
            if (!video) {
                console.log('[YouTube倍速] 警告：找不到video元素');
                return;
            }

            console.log('[YouTube倍速] 当前视频速度:', video.playbackRate);

            // 如果是长按状态，恢复原速度
            if (isPressing && isLongPress && currentKey === 'ArrowRight') {
                video.playbackRate = originalSpeed;
                console.log('[YouTube倍速] 右方向键松开，恢复速度:', originalSpeed);
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else if (currentKey === 'ArrowRight') {
                // 兜底处理
                if (video.playbackRate === SPEED_KEY_RIGHT) {
                    video.playbackRate = originalSpeed;
                    console.log('[YouTube倍速] 右方向键松开（兜底），恢复速度:', originalSpeed);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            } else {
                console.log('[YouTube倍速] 所有条件都不满足，强制恢复速度');
                // 强制恢复
                if (video.playbackRate === SPEED_KEY_RIGHT) {
                    video.playbackRate = originalSpeed;
                    console.log('[YouTube倍速] 强制恢复速度:', originalSpeed);
                }
                isPressing = false;
                isLongPress = false;
                currentKey = null;
                hideOverlay();
                updateSpeedHighlight();
            }
        }
    }

    // ==================== 外置倍速控件 ====================
    function createSpeedControl() {
        try {
            // 创建容器 - 与 YouTube 原生控件风格一致
            const container = document.createElement('div');
            container.classList.add('yt-speed-control');
            container.style.cssText = `
                display: inline-flex !important;
                align-items: center !important;
                height: 100% !important;
                padding: 0 !important;
                margin: 0 4px 0 0 !important;
                color: #fff !important;
                font-size: 13px !important;
                font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                vertical-align: top !important;
                flex-shrink: 0 !important;
                position: relative !important;
                width: auto !important;
            `;

            // 创建倍速按钮容器
            const buttonsContainer = document.createElement('div');
            buttonsContainer.classList.add('yt-speed-buttons');
            buttonsContainer.style.cssText = `
                display: inline-flex !important;
                align-items: center !important;
                height: 100% !important;
            `;

            SPEED_OPTIONS.forEach(speed => {
                const option = document.createElement('button');
                option.classList.add('yt-speed-option');
                option.innerText = speed + 'x';
                option.dataset.speed = speed;
                option.title = speed + '倍速';
                option.style.cssText = `
                    cursor: pointer !important;
                    margin: 0 !important;
                    padding: 0 6px !important;
                    height: 100% !important;
                    width: auto !important;
                    min-width: 32px !important;
                    border: none !important;
                    background: transparent !important;
                    color: rgba(255, 255, 255, 0.9) !important;
                    font-size: 13px !important;
                    font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                    font-weight: 400 !important;
                    transition: opacity 0.1s ease-in-out !important;
                    white-space: nowrap !important;
                    flex-shrink: 0 !important;
                    outline: none !important;
                    opacity: 0.9 !important;
                    box-sizing: border-box !important;
                `;

                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const video = getVideo();
                    if (video) {
                        video.playbackRate = speed;
                        originalSpeed = speed;
                        highlightOption(option);
                    }
                });

                option.addEventListener('mouseenter', () => {
                    option.style.opacity = '1';
                });

                option.addEventListener('mouseleave', () => {
                    const video = getVideo();
                    const currentSpeed = video ? video.playbackRate : 1;
                    if (parseFloat(option.dataset.speed) !== currentSpeed) {
                        option.style.opacity = '0.9';
                    }
                });

                buttonsContainer.appendChild(option);
            });

            // 创建自定义设置按钮
            const customButton = createCustomSpeedButton();

            container.appendChild(buttonsContainer);
            container.appendChild(customButton);

            return container;
        } catch (error) {
            console.error('创建倍速控件失败:', error);
            // 如果创建自定义按钮失败，返回只有基本按钮的容器
            const container = document.createElement('div');
            container.classList.add('yt-speed-control');
            container.style.cssText = `
                display: inline-flex !important;
                align-items: center !important;
                height: 100% !important;
                padding: 0 !important;
                margin: 0 4px 0 0 !important;
                color: #fff !important;
                font-size: 13px !important;
                font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                vertical-align: top !important;
                flex-shrink: 0 !important;
                position: relative !important;
                width: auto !important;
            `;

            SPEED_OPTIONS.forEach(speed => {
                const option = document.createElement('button');
                option.classList.add('yt-speed-option');
                option.innerText = speed + 'x';
                option.dataset.speed = speed;
                option.title = speed + '倍速';
                option.style.cssText = `
                    cursor: pointer !important;
                    margin: 0 !important;
                    padding: 0 6px !important;
                    height: 100% !important;
                    width: auto !important;
                    min-width: 32px !important;
                    border: none !important;
                    background: transparent !important;
                    color: rgba(255, 255, 255, 0.9) !important;
                    font-size: 13px !important;
                    font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                    font-weight: 400 !important;
                    transition: opacity 0.1s ease-in-out !important;
                    white-space: nowrap !important;
                    flex-shrink: 0 !important;
                    outline: none !important;
                    opacity: 0.9 !important;
                    box-sizing: border-box !important;
                `;

                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const video = getVideo();
                    if (video) {
                        video.playbackRate = speed;
                        originalSpeed = speed;
                        highlightOption(option);
                    }
                });

                option.addEventListener('mouseenter', () => {
                    option.style.opacity = '1';
                });

                option.addEventListener('mouseleave', () => {
                    const video = getVideo();
                    const currentSpeed = video ? video.playbackRate : 1;
                    if (parseFloat(option.dataset.speed) !== currentSpeed) {
                        option.style.opacity = '0.9';
                    }
                });

                container.appendChild(option);
            });

            return container;
        }
    }

    // 创建自定义倍速设置按钮
    function createCustomSpeedButton() {
        try {
            const buttonContainer = document.createElement('div');
            buttonContainer.classList.add('yt-speed-custom-container');
            buttonContainer.style.cssText = `
                display: inline-flex !important;
                align-items: center !important;
                height: 100% !important;
                position: relative !important;
            `;

            const customBtn = document.createElement('button');
            customBtn.classList.add('yt-speed-custom-btn');
            customBtn.textContent = '⚙';
            customBtn.title = '自定义倍速';
            customBtn.style.cssText = `
                cursor: pointer !important;
                margin: 0 !important;
                padding: 0 6px !important;
                height: 100% !important;
                width: auto !important;
                min-width: 28px !important;
                border: none !important;
                background: transparent !important;
                color: rgba(255, 255, 255, 0.7) !important;
                font-size: 16px !important;
                font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                transition: all 0.2s ease-in-out !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
                outline: none !important;
                box-sizing: border-box !important;
            `;

            // 创建编辑面板
            const editPanel = createEditPanel();
            buttonContainer.appendChild(customBtn);
            buttonContainer.appendChild(editPanel);

            // 点击显示/隐藏面板
            let isPanelVisible = false;

            const togglePanel = (e) => {
                e.stopPropagation();
                e.preventDefault();
                isPanelVisible = !isPanelVisible;
                if (isPanelVisible) {
                    customBtn.style.color = 'rgba(255, 255, 255, 1)';
                    editPanel.style.display = 'block';
                } else {
                    customBtn.style.color = 'rgba(255, 255, 255, 0.7)';
                    editPanel.style.display = 'none';
                }
            };

            customBtn.addEventListener('click', togglePanel, true);

            // 点击面板外部关闭
            document.addEventListener('click', (e) => {
                if (isPanelVisible && !buttonContainer.contains(e.target)) {
                    isPanelVisible = false;
                    customBtn.style.color = 'rgba(255, 255, 255, 0.7)';
                    editPanel.style.display = 'none';
                }
            });

            // 阻止面板内点击事件冒泡
            editPanel.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            return buttonContainer;
        } catch (error) {
            console.error('创建自定义按钮失败:', error);
            // 返回一个空的 div 作为降级方案
            return document.createElement('div');
        }
    }

    // 创建编辑面板
    function createEditPanel() {
        try {
            const panel = document.createElement('div');
            panel.classList.add('yt-speed-edit-panel');
            panel.style.cssText = `
                display: none !important;
                position: absolute !important;
                bottom: 100% !important;
                right: 0 !important;
                margin-bottom: 8px !important;
                background: rgba(0, 0, 0, 0.6) !important;
                border-radius: 12px !important;
                padding: 8px 0 !important;
                width: 251px !important;
                max-height: 414px !important;
                overflow-y: auto !important;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5) !important;
                z-index: 10000 !important;
                // color: #fff !important;
                color: rgba(255, 255, 255, 0.9) !important;
                font-family: Roboto, Arial, sans-serif !important;
            `;

            // 添加新倍速区域 - 滑块样式(放在顶部)
            const addSection = document.createElement('div');
            addSection.style.cssText = `
                padding: 12px 16px 10px 16px !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
            `;

            // 标题和当前值
            const sliderHeader = document.createElement('div');
            sliderHeader.style.cssText = `
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                margin-bottom: 10px !important;
            `;

            const sliderTitle = document.createElement('div');
            sliderTitle.textContent = '自定义 (0.5)';
            sliderTitle.style.cssText = `
                color: #fff !important;
                font-size: 14px !important;
                font-weight: 400 !important;
            `;

            const sliderValue = document.createElement('div');
            sliderValue.textContent = '0.50x';
            sliderValue.style.cssText = `
                color: #fff !important;
                font-size: 16px !important;
                font-weight: 500 !important;
            `;

            sliderHeader.appendChild(sliderTitle);
            sliderHeader.appendChild(sliderValue);

            // 滑块容器
            const sliderContainer = document.createElement('div');
            sliderContainer.style.cssText = `
                position: relative !important;
                width: 100% !important;
                height: 4px !important;
                background: rgba(255, 255, 255, 0.3) !important;
                border-radius: 2px !important;
                margin-bottom: 10px !important;
            `;

            // 滑块
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0.25';
            slider.max = '4';
            slider.step = '0.05';
            slider.value = '0.5';
            slider.style.cssText = `
                position: absolute !important;
                width: 100% !important;
                height: 20px !important;
                top: -8px !important;
                left: 0 !important;
                margin: 0 !important;
                padding: 0 !important;
                -webkit-appearance: none !important;
                appearance: none !important;
                background: transparent !important;
                outline: none !important;
                cursor: pointer !important;
            `;

            // 滑块样式
            const sliderStyleId = 'yt-speed-slider-style';
            if (!document.getElementById(sliderStyleId)) {
                const sliderStyle = document.createElement('style');
                sliderStyle.id = sliderStyleId;
                sliderStyle.textContent = `
                    .yt-speed-slider::-webkit-slider-thumb {
                        -webkit-appearance: none !important;
                        appearance: none !important;
                        width: 16px !important;
                        height: 16px !important;
                        border-radius: 50% !important;
                        background: #fff !important;
                        cursor: pointer !important;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3) !important;
                    }
                    .yt-speed-slider::-moz-range-thumb {
                        width: 16px !important;
                        height: 16px !important;
                        border-radius: 50% !important;
                        background: #fff !important;
                        cursor: pointer !important;
                        border: none !important;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3) !important;
                    }
                `;
                document.head.appendChild(sliderStyle);
            }
            slider.classList.add('yt-speed-slider');

            // 更新显示值
            slider.addEventListener('input', (e) => {
                e.stopPropagation();
                const value = parseFloat(e.target.value);
                sliderValue.textContent = value.toFixed(2) + 'x';
                sliderTitle.textContent = `自定义 (${value.toFixed(2)})`;
            });

            // 阻止键盘事件冒泡
            slider.addEventListener('keydown', (e) => {
                e.stopPropagation();
            });

            slider.addEventListener('keyup', (e) => {
                e.stopPropagation();
            });

            // 添加确认按钮
            const addButton = document.createElement('button');
            addButton.textContent = '添加';
            addButton.style.cssText = `
                width: 100% !important;
                padding: 6px !important;
                background: rgba(255, 255, 255, 0.1) !important;
                border: none !important;
                border-radius: 4px !important;
                color: #fff !important;
                font-size: 13px !important;
                cursor: pointer !important;
                transition: background 0.2s !important;
            `;

            addButton.addEventListener('mouseenter', () => {
                addButton.style.background = 'rgba(255, 255, 255, 0.15) !important';
            });

            addButton.addEventListener('mouseleave', () => {
                addButton.style.background = 'rgba(255, 255, 255, 0.1) !important';
            });

            // 消息提示
            const messageDiv = document.createElement('div');
            messageDiv.style.cssText = `
                font-size: 11px !important;
                margin-top: 6px !important;
                padding: 4px !important;
                border-radius: 3px !important;
                display: none !important;
                text-align: center !important;
            `;

            const showMessage = (text, isSuccess) => {
                messageDiv.textContent = text;
                messageDiv.style.display = 'block';
                messageDiv.style.background = isSuccess ? 'rgba(48, 209, 88, 0.2) !important' : 'rgba(255, 69, 58, 0.2) !important';
                messageDiv.style.color = isSuccess ? '#4cd964 !important' : '#ff453a !important';

                setTimeout(() => {
                    messageDiv.style.display = 'none';
                }, 2000);
            };

            sliderContainer.appendChild(slider);
            addSection.appendChild(sliderHeader);
            addSection.appendChild(sliderContainer);
            addSection.appendChild(addButton);
            addSection.appendChild(messageDiv);
            panel.appendChild(addSection);

            // 倍速列表容器
            const listContainer = document.createElement('div');
            listContainer.classList.add('yt-speed-list');
            listContainer.style.cssText = `
                padding: 4px 0 !important;
            `;
            panel.appendChild(listContainer);

            // 渲染倍速列表
            renderSpeedList(listContainer);

            // 点击添加按钮添加倍速
            addButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = parseFloat(slider.value);
                const allSpeeds = [...PRESET_SPEEDS, ...CUSTOM_SPEEDS];

                if (allSpeeds.includes(value)) {
                    showMessage('该倍速已存在', false);
                    return;
                }

                // 添加成功
                CUSTOM_SPEEDS.push(value);
                CUSTOM_SPEEDS.sort((a, b) => a - b);
                SPEED_OPTIONS.push(value);
                SPEED_OPTIONS.sort((a, b) => a - b);
                saveSpeedOptions();
                refreshSpeedControl();
                renderSpeedList(listContainer);
                showMessage('添加成功', true);
            });

            return panel;
        } catch (error) {
            console.error('创建编辑面板失败:', error);
            // 返回一个空的 div 作为降级方案
            return document.createElement('div');
        }
    }

    // 渲染倍速列表
    function renderSpeedList(container) {
        // 清空容器
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        // 合并所有倍速并排序
        const allSpeeds = [...new Set([...PRESET_SPEEDS, ...CUSTOM_SPEEDS])].sort((a, b) => a - b);

        allSpeeds.forEach(speed => {
            const isPreset = PRESET_SPEEDS.includes(speed);
            const isVisible = SPEED_OPTIONS.includes(speed);

            const item = document.createElement('div');
            item.style.cssText = `
                display: flex !important;
                align-items: center !important;
                padding: 8px 16px !important;
                cursor: pointer !important;
                transition: background 0.1s !important;
                background: transparent !important;
            `;

            item.addEventListener('mouseenter', () => {
                item.style.background = 'rgba(255, 255, 255, 0.1) !important';
            });

            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent !important';
            });

            // 勾选框
            const checkbox = document.createElement('div');
            checkbox.style.cssText = `
                width: 18px !important;
                height: 18px !important;
                margin-right: 16px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                flex-shrink: 0 !important;
            `;

            if (isVisible) {
                const checkmark = document.createElement('div');
                checkmark.textContent = '✓';
                checkmark.style.cssText = `
                    color: #fff !important;
                    font-size: 18px !important;
                    font-weight: 500 !important;
                    line-height: 1 !important;
                `;
                checkbox.appendChild(checkmark);
            }

            // 倍速文本
            const speedText = document.createElement('span');
            if (speed === 1) {
                speedText.textContent = '正常';
            } else {
                speedText.textContent = speed.toString();
            }
            speedText.style.cssText = `
                color: #fff !important;
                font-size: 14px !important;
                flex: 1 !important;
                font-weight: 400 !important;
            `;

            // 删除按钮(仅自定义倍速)
            if (!isPreset) {
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '×';
                deleteBtn.style.cssText = `
                    background: transparent !important;
                    border: none !important;
                    color: rgba(255, 255, 255, 0.7) !important;
                    font-size: 20px !important;
                    cursor: pointer !important;
                    padding: 0 !important;
                    width: 24px !important;
                    height: 24px !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    border-radius: 50% !important;
                    transition: all 0.2s !important;
                `;

                deleteBtn.addEventListener('mouseenter', () => {
                    deleteBtn.style.background = 'rgba(255, 255, 255, 0.1) !important';
                    deleteBtn.style.color = '#fff !important';
                });

                deleteBtn.addEventListener('mouseleave', () => {
                    deleteBtn.style.background = 'transparent !important';
                    deleteBtn.style.color = 'rgba(255, 255, 255, 0.7) !important';
                });

                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    CUSTOM_SPEEDS = CUSTOM_SPEEDS.filter(s => s !== speed);
                    SPEED_OPTIONS = SPEED_OPTIONS.filter(s => s !== speed);
                    saveSpeedOptions();
                    refreshSpeedControl();
                    renderSpeedList(container);
                });

                item.appendChild(speedText);
                item.appendChild(deleteBtn);
            } else {
                item.appendChild(speedText);
            }

            // 点击切换显示/隐藏
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (isVisible) {
                    SPEED_OPTIONS = SPEED_OPTIONS.filter(s => s !== speed);
                } else {
                    SPEED_OPTIONS.push(speed);
                    SPEED_OPTIONS.sort((a, b) => a - b);
                }
                saveSpeedOptions();
                refreshSpeedControl();
                renderSpeedList(container);
            });

            item.insertBefore(checkbox, item.firstChild);
            container.appendChild(item);
        });
    }

    // 保存倍速选项到 localStorage
    function saveSpeedOptions() {
        try {
            const data = {
                visible: SPEED_OPTIONS,
                custom: CUSTOM_SPEEDS
            };
            localStorage.setItem('yt-custom-speed-options', JSON.stringify(data));
        } catch (e) {
            console.error('保存倍速选项失败:', e);
        }
    }

    // 从 localStorage 加载倍速选项
    function loadSpeedOptions() {
        try {
            const saved = localStorage.getItem('yt-custom-speed-options');
            if (saved) {
                const data = JSON.parse(saved);
                if (data.visible) {
                    SPEED_OPTIONS = data.visible;
                }
                if (data.custom) {
                    CUSTOM_SPEEDS = data.custom;
                }
            }
        } catch (e) {
            console.error('加载倍速选项失败:', e);
        }
    }

    // 刷新倍速控件
    function refreshSpeedControl() {
        const buttonsContainer = document.querySelector('.yt-speed-buttons');
        if (!buttonsContainer) {
            // 如果控件不存在,重新插入
            const oldControl = document.querySelector('.yt-speed-control');
            if (oldControl) {
                oldControl.remove();
            }
            insertSpeedControl();
            return;
        }

        // 只更新倍速按钮,保留自定义按钮和面板
        while (buttonsContainer.firstChild) {
            buttonsContainer.removeChild(buttonsContainer.firstChild);
        }

        SPEED_OPTIONS.forEach(speed => {
            const option = document.createElement('button');
            option.classList.add('yt-speed-option');
            option.innerText = speed + 'x';
            option.dataset.speed = speed;
            option.title = speed + '倍速';
            option.style.cssText = `
                cursor: pointer !important;
                margin: 0 !important;
                padding: 0 6px !important;
                height: 100% !important;
                width: auto !important;
                min-width: 32px !important;
                border: none !important;
                background: transparent !important;
                color: rgba(255, 255, 255, 0.9) !important;
                font-size: 13px !important;
                font-family: 'YouTube Sans', 'Roboto', Arial, sans-serif !important;
                font-weight: 400 !important;
                transition: opacity 0.1s ease-in-out !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
                outline: none !important;
                opacity: 0.9 !important;
                box-sizing: border-box !important;
            `;

            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const video = getVideo();
                if (video) {
                    video.playbackRate = speed;
                    originalSpeed = speed;
                    highlightOption(option);
                }
            });

            option.addEventListener('mouseenter', () => {
                option.style.opacity = '1';
            });

            option.addEventListener('mouseleave', () => {
                const video = getVideo();
                const currentSpeed = video ? video.playbackRate : 1;
                if (parseFloat(option.dataset.speed) !== currentSpeed) {
                    option.style.opacity = '0.9';
                }
            });

            buttonsContainer.appendChild(option);
        });

        // 更新高亮
        updateSpeedHighlight();
    }

    function highlightOption(selectedOption) {
        const options = document.querySelectorAll('.yt-speed-option');
        options.forEach(option => {
            option.style.color = 'rgba(255, 255, 255, 0.9)';
            option.style.fontWeight = '400';
            option.style.opacity = '0.9';
        });
        if (selectedOption) {
            selectedOption.style.color = '#fff';
            selectedOption.style.fontWeight = '600';
            selectedOption.style.opacity = '1';
        }
    }

    function updateSpeedHighlight() {
        const video = getVideo();
        if (!video) return;

        const currentSpeed = video.playbackRate;
        const options = document.querySelectorAll('.yt-speed-option');
        options.forEach(option => {
            if (parseFloat(option.dataset.speed) === currentSpeed) {
                highlightOption(option);
            }
        });
    }

    function injectStyles() {
        if (document.getElementById('yt-speed-styles')) return;

        const style = document.createElement('style');
        style.id = 'yt-speed-styles';
        style.textContent = `
            .ytp-right-controls-left {
                overflow: visible !important;
                flex-shrink: 0 !important;
            }
            .ytp-right-controls {
                overflow: visible !important;
            }
            .ytp-chrome-controls .ytp-right-controls {
                flex-wrap: nowrap !important;
            }
            .yt-speed-control {
                display: inline-flex !important;
                visibility: visible !important;
                align-items: center !important;
                flex-shrink: 0 !important;
                width: auto !important;
                min-width: fit-content !important;
            }
            .yt-speed-option {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                visibility: visible !important;
                flex-shrink: 0 !important;
            }
            .yt-speed-option:hover {
                opacity: 1 !important;
            }
            .yt-speed-edit-panel::-webkit-scrollbar {
                width: 6px !important;
            }
            .yt-speed-edit-panel::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.1) !important;
                border-radius: 3px !important;
            }
            .yt-speed-edit-panel::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.3) !important;
                border-radius: 3px !important;
            }
            .yt-speed-edit-panel::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.5) !important;
            }
            .yt-speed-list::-webkit-scrollbar {
                width: 8px !important;
            }
            .yt-speed-list::-webkit-scrollbar-track {
                background: transparent !important;
                margin: 4px 0 !important;
            }
            .yt-speed-list::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.25) !important;
                border-radius: 4px !important;
                border: 2px solid transparent !important;
                background-clip: padding-box !important;
            }
            .yt-speed-list::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.4) !important;
                background-clip: padding-box !important;
            }
        `;
        document.head.appendChild(style);
    }

    function insertSpeedControl() {
        try {
            // 注入样式
            injectStyles();

            // 查找 ytp-right-controls-left 容器
            const rightControlsLeft = document.querySelector('.ytp-right-controls-left');
            if (!rightControlsLeft || document.querySelector('.yt-speed-control')) return;

            const speedControl = createSpeedControl();

            // 插入到 ytp-right-controls-left 的最前面
            rightControlsLeft.insertBefore(speedControl, rightControlsLeft.firstChild);

            // 初始化高亮
            updateSpeedHighlight();

            // 监听视频速度变化
            const video = getVideo();
            if (video) {
                video.addEventListener('ratechange', () => {
                    if (!isPressing) {
                        updateSpeedHighlight();
                    }
                });
            }
        } catch (error) {
            console.error('插入倍速控件失败:', error);
        }
    }

    // ==================== 初始化 ====================
    function init() {
        try {
            // 加载自定义倍速选项
            loadSpeedOptions();

            // 注册键盘事件
            document.addEventListener('keydown', handleKeyDown, true);
            document.addEventListener('keyup', handleKeyUp, true);

            // 额外的全局监听器，监听Ctrl键状态（兜底机制）
            window.addEventListener('blur', () => {
                // 窗口失焦时，强制恢复速度
                if (ctrlKeyState.isDown) {
                    console.log('[YouTube倍速] 窗口失焦，强制恢复Ctrl键状态');
                    const video = getVideo();
                    if (video && video.playbackRate === SPEED_KEY_CTRL) {
                        video.playbackRate = ctrlKeyState.originalSpeed;
                    }
                    ctrlKeyState.isDown = false;
                    if (ctrlKeyState.checkInterval) {
                        clearInterval(ctrlKeyState.checkInterval);
                        ctrlKeyState.checkInterval = null;
                    }
                    isPressing = false;
                    isLongPress = false;
                    currentKey = null;
                    hideOverlay();
                    updateSpeedHighlight();
                }
            }, true);

            // 监听鼠标点击，如果Ctrl键应该松开但没有触发keyup
            document.addEventListener('mousedown', () => {
                if (ctrlKeyState.isDown) {
                    const video = getVideo();
                    if (video && video.playbackRate === SPEED_KEY_CTRL) {
                        console.log('[YouTube倍速] 检测到鼠标点击，检查Ctrl键状态');
                        // 延迟检查，因为可能是Ctrl+点击
                        setTimeout(() => {
                            if (ctrlKeyState.isDown && video.playbackRate === SPEED_KEY_CTRL) {
                                console.log('[YouTube倍速] Ctrl键可能卡住，尝试恢复');
                                video.playbackRate = ctrlKeyState.originalSpeed;
                                ctrlKeyState.isDown = false;
                                if (ctrlKeyState.checkInterval) {
                                    clearInterval(ctrlKeyState.checkInterval);
                                    ctrlKeyState.checkInterval = null;
                                }
                                isPressing = false;
                                isLongPress = false;
                                currentKey = null;
                                hideOverlay();
                                updateSpeedHighlight();
                            }
                        }, 100);
                    }
                }
            }, true);

            // 注册链接点击事件（新标签页打开功能）
            document.addEventListener('click', handleLinkClick, true);

            // 页面加载时暂停视频
            document.addEventListener('DOMContentLoaded', pauseVideoOnLoad);

            // 使用 MutationObserver 监听 DOM 变化
            const observer = new MutationObserver(() => {
                insertSpeedControl();
            });

            // 等待 body 加载后再启动 observer
            if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true });
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    observer.observe(document.body, { childList: true, subtree: true });
                });
            }

            // 页面加载完成后尝试插入
            window.addEventListener('load', insertSpeedControl);

            // 立即尝试插入（如果DOM已就绪）
            if (document.readyState !== 'loading') {
                insertSpeedControl();
            }
        } catch (error) {
            console.error('[YouTube倍速控件] 初始化失败:', error);
        }
    }

    init();
})();

