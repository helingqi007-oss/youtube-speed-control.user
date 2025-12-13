// ==UserScript==
// @name         YouTube 长按倍速播放 + 倍速按钮 + 新标签页打开
// @namespace    Tampermonkey Scripts
// @match        *://www.youtube.com/*
// @grant        none
// @version      1.2
// @author       
// @description  长按Z键2倍速、长按右方向键3倍速播放，松开恢复原速度。视频控制栏添加倍速切换按钮。YouTube链接强制新标签页打开（章节链接除外）。
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    // 倍速相关配置
    const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3];
    const SPEED_KEY_Z = 2.0;
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
        if (e.code !== 'KeyZ' && e.code !== 'ArrowRight') return;

        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Z键保持原有行为：立即触发倍速
        if (e.code === 'KeyZ') {
            if (isPressing) return;

            const video = getVideo();
            if (!video) return;

            isPressing = true;
            isLongPress = true;
            currentKey = e.code;
            originalSpeed = video.playbackRate;

            video.playbackRate = SPEED_KEY_Z;
            showOverlay(SPEED_KEY_Z);
            updateSpeedHighlight();
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

                video.playbackRate = SPEED_KEY_RIGHT;
                showOverlay(SPEED_KEY_RIGHT);
                updateSpeedHighlight();
            }, LONG_PRESS_DELAY);
        }
    }

    function handleKeyUp(e) {
        if (e.code !== 'KeyZ' && e.code !== 'ArrowRight') return;

        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Z键松开处理
        if (e.code === 'KeyZ') {
            if (isPressing && currentKey === 'KeyZ') {
                const video = getVideo();
                if (video) {
                    video.playbackRate = originalSpeed;
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

            // 如果定时器还在运行，说明是短按
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                currentKey = null;

                // 手动执行快进操作（补偿被阻止的默认行为）
                const video = getVideo();
                if (video) {
                    video.currentTime = Math.min(video.currentTime + SEEK_SECONDS, video.duration);
                }
                return;
            }

            // 如果是长按状态，恢复原速度
            if (isPressing && isLongPress && currentKey === 'ArrowRight') {
                const video = getVideo();
                if (video) {
                    video.playbackRate = originalSpeed;
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
        `;
        document.head.appendChild(style);
    }

    function insertSpeedControl() {
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
    }

    // ==================== 初始化 ====================
    function init() {
        // 注册键盘事件
        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('keyup', handleKeyUp, true);

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
    }

    init();
})();

