/**
 * Icons.tsx — Centralized FontAwesome icon definitions for CodeArchy.
 *
 * All icons used in the UI are defined here. To add a new icon:
 *  1. Import the icon from @fortawesome/free-solid-svg-icons
 *  2. Add an entry to AppIcons with a semantic name
 *  3. Use <Icon name="yourKey" /> anywhere in the UI
 *
 * Icons are bundled as inline SVGs by esbuild — no network or font files needed.
 */

import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition, SizeProp } from '@fortawesome/fontawesome-svg-core';
import {
    // View mode tabs
    faLayerGroup,        // System architecture view
    faSitemap,           // Flow (React Flow) view
    faShareNodes,        // Dense (Cytoscape) view

    // Toolbar actions
    faBrain,             // AI Analyze
    faGear,              // Model settings
    faMap,               // Mini-map toggle
    faRotate,            // Refresh
    faFileCode,          // Export SVG
    faImage,             // Export PNG

    // Chat panel
    faComments,          // Chat FAB button
    faTrash,             // Clear chat
    faChevronDown,       // Minimize chat
    faXmark,             // Close / dismiss
    faMicrophone,        // Voice input (start)
    faStop,              // Stop (recording / speaking)
    faPaperPlane,        // Send message
    faVolumeHigh,        // Read aloud (TTS)
    faUser,              // User avatar
    faRobot,             // Assistant avatar

    // Status / alerts
    faTriangleExclamation, // Warning / error notice
    faCheck,             // Installed / success
    faCircleCheck,       // Installed badge (alternative)

    // Dependency arrows (DetailPanel)
    faArrowRight,        // Outgoing dependency
    faArrowLeft,         // Incoming dependency

    // System node type icons (SystemView)
    faCubes,             // Subsystem node
    faServer,            // Service node
    faArrowUpRightFromSquare, // External node
    faDatabase,          // Database / persistence
    faBolt,              // Cache / fast in-memory
    faEnvelopesBulk,     // Queue / message bus
    faNetworkWired,      // API gateway / router
    faDesktop,           // UI / frontend / client
    faShieldHalved,      // Auth / security
    faCloud,             // External cloud / third-party
    faMicrochip,         // Worker / processor

    // Misc
    faExpand,            // Fit-to-view (Cytoscape) / expand panel
    faCompress,          // Collapse panel
    faSpinner,           // Loading spinner
    faWandMagicSparkles, // AI magic (alternate AI icon)
} from '@fortawesome/free-solid-svg-icons';

// ---------------------------------------------------------------------------
// Master icon registry — one place to manage all icons in the project
// ---------------------------------------------------------------------------
export const AppIcons: Record<string, IconDefinition> = {
    // ---- View mode tabs ----
    systemView: faLayerGroup,
    flowView: faSitemap,
    denseView: faShareNodes,

    // ---- Toolbar actions ----
    aiAnalyze: faBrain,
    modelSettings: faGear,
    miniMap: faMap,
    refresh: faRotate,
    exportSvg: faFileCode,
    exportPng: faImage,

    // ---- Chat panel ----
    chatFab: faComments,
    clearChat: faTrash,
    minimize: faChevronDown,
    close: faXmark,
    voiceInput: faMicrophone,
    stopAction: faStop,
    send: faPaperPlane,
    speakAloud: faVolumeHigh,
    userAvatar: faUser,
    botAvatar: faRobot,
    expandPanel: faExpand,
    collapsePanel: faCompress,

    // ---- Status / alerts ----
    warning: faTriangleExclamation,
    installed: faCircleCheck,
    notInstalled: faXmark,

    // ---- Dependency arrows ----
    depOut: faArrowRight,
    depIn: faArrowLeft,

    // ---- System node types ----
    nodeSubsystem: faCubes,
    nodeLayer: faLayerGroup,
    nodeService: faServer,
    nodeExternal: faArrowUpRightFromSquare,
    nodeDatabase: faDatabase,
    nodeCache: faBolt,
    nodeQueue: faEnvelopesBulk,
    nodeGateway: faNetworkWired,
    nodeUi: faDesktop,
    nodeAuth: faShieldHalved,
    nodeCloud: faCloud,
    nodeWorker: faMicrochip,

    // ---- Misc ----
    fitView: faExpand,
    spinner: faSpinner,
    aiMagic: faWandMagicSparkles,
    check: faCheck,
} as const;

export type AppIconName = keyof typeof AppIcons;

// ---------------------------------------------------------------------------
// <Icon> component — drop-in replacement for emoji / unicode symbols
// ---------------------------------------------------------------------------
interface IconProps {
    /** Semantic icon name from AppIcons */
    name: AppIconName;
    /** Extra CSS classes */
    className?: string;
    /** FontAwesome size, e.g. "sm" | "lg" | "xl" | "2x" */
    size?: SizeProp;
    /** Spin animation (for loading states) */
    spin?: boolean;
    /** Fixed-width mode — useful in lists / buttons for consistent alignment */
    fixedWidth?: boolean;
    /** Accessible label (sets aria-label) */
    title?: string;
}

export function Icon({ name, className, size, spin, fixedWidth, title }: IconProps) {
    return (
        <FontAwesomeIcon
            icon={AppIcons[name]}
            className={className}
            size={size}
            spin={spin}
            fixedWidth={fixedWidth}
            title={title}
            aria-hidden={!title}
        />
    );
}
