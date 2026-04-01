import {
  Component,
  signal,
  computed,
  viewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  NgZone,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as go from 'gojs';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ShapeType = 'rectangle' | 'circle' | 'diamond' | 'process';

export type LayoutType = 'tree' | 'layered' | 'force' | 'circular' | 'grid';

export interface NodeData {
  key: string;
  label: string;
  category: ShapeType;
  color: string;
  loc: string;
  group?: string;
  isGroup?: false;
}

export interface GroupData {
  key: string;
  label: string;
  isGroup: true;
  color: string;
  loc: string;
}

export interface LinkData {
  key: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface DiagramFile {
  version: '1.0';
  engine: 'gojs';
  nodeDataArray: (NodeData | GroupData)[];
  linkDataArray: LinkData[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const LS_KEY = 'gojs-diagram';
const GRID_SIZE = 10;

// ─── SnappingCommandHandler ────────────────────────────────────────────────────
// Adds arrow-key nudging (GoJS 3 removed arrowKeyNudge).
// Normal arrow key  → moves by GRID_SIZE (stays on grid).
// Shift + arrow key → moves by 1 px (fine control).

class SnappingCommandHandler extends go.CommandHandler {
  override doKeyDown(): void {
    const diagram = this.diagram;
    const key = diagram.lastInput.commandKey;
    const isArrow = key === 'ArrowUp' || key === 'ArrowDown' ||
                    key === 'ArrowLeft' || key === 'ArrowRight';

    if (isArrow) {
      const sel = diagram.selection;
      const parts: go.Node[] = [];
      sel.each(p => {
        if (p instanceof go.Node) {
          // Skip members whose containing group is already moving
          if (!p.containingGroup?.isSelected) {
            parts.push(p);
          }
        }
      });

      if (parts.length > 0) {
        const dist = diagram.lastInput.shift ? 1 : GRID_SIZE;
        let dx = 0, dy = 0;
        if (key === 'ArrowRight') dx = dist;
        else if (key === 'ArrowLeft') dx = -dist;
        else if (key === 'ArrowDown') dy = dist;
        else if (key === 'ArrowUp') dy = -dist;

        diagram.startTransaction('arrow move');
        for (const p of parts) {
          const loc = p.location;
          p.location = new go.Point(loc.x + dx, loc.y + dy);
        }
        diagram.commitTransaction('arrow move');

        // Show alignment guides after move, auto-hide after 800 ms
        const dt = diagram.toolManager.draggingTool;
        if (dt instanceof GuidedDraggingTool) {
          dt.updateGuides(parts);
          dt.clearGuides(800);
        }

        return; // Consumed — don't scroll
      }
    }

    super.doKeyDown();
  }
}

// ─── GuidedDraggingTool ────────────────────────────────────────────────────────
// Shows temporary alignment guide lines when a dragged node's
// left/center/right or top/center/bottom aligns with another node.

class GuidedDraggingTool extends go.DraggingTool {
  private _guides: go.Part[] = [];
  private _clearTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _guideStroke = '#3b82f6';
  private readonly _snapDist = 8;

  override doMouseMove(): void {
    super.doMouseMove();
    if (this.isActive) this.updateGuides();
  }

  override doMouseUp(): void {
    this.clearGuides();
    super.doMouseUp();
  }

  override doDeactivate(): void {
    this.clearGuides();
    super.doDeactivate();
  }

  /** Clear guides immediately, or after a delay (ms) for auto-hide. */
  clearGuides(delay = 0): void {
    if (this._clearTimer !== null) {
      clearTimeout(this._clearTimer);
      this._clearTimer = null;
    }
    if (delay > 0) {
      this._clearTimer = setTimeout(() => { this._doHide(); }, delay);
    } else {
      this._doHide();
    }
  }

  private _doHide(): void {
    if (this._guides.length === 0) return;
    const d = this.diagram;
    const prev = d.skipsUndoManager;
    d.skipsUndoManager = true;
    d.startTransaction('clearGuides');
    for (const g of this._guides) d.remove(g);
    d.commitTransaction('clearGuides');
    d.skipsUndoManager = prev;
    this._guides = [];
  }

  /** Compute and show alignment guides for the given nodes. */
  updateGuides(nodes?: go.Node[]): void {
    this._doHide();
    const d = this.diagram;

    // Collect nodes to show guides for
    let dragged: go.Node[];
    if (nodes) {
      dragged = nodes;
    } else {
      const dp = this.draggedParts;
      if (!dp) return;
      dragged = [];
      const iter = dp.iterator;
      while (iter.next()) {
        if (iter.key instanceof go.Node) dragged.push(iter.key);
      }
    }
    if (dragged.length === 0) return;

    // Bounding box of all dragged nodes
    let bounds: go.Rect | null = null;
    for (const n of dragged) {
      if (bounds) bounds.unionRect(n.actualBounds);
      else bounds = n.actualBounds.copy();
    }
    if (!bounds) return;

    const dragYs = [bounds.top, bounds.centerY, bounds.bottom];
    const dragXs = [bounds.left, bounds.centerX, bounds.right];
    const hPositions = new Set<number>();
    const vPositions = new Set<number>();

    d.nodes.each(node => {
      if (dragged.includes(node)) return;
      const b = node.actualBounds;
      for (const ny of [b.top, b.centerY, b.bottom]) {
        for (const dy of dragYs) {
          if (Math.abs(ny - dy) <= this._snapDist) hPositions.add(ny);
        }
      }
      for (const nx of [b.left, b.centerX, b.right]) {
        for (const dx of dragXs) {
          if (Math.abs(nx - dx) <= this._snapDist) vPositions.add(nx);
        }
      }
    });

    if (hPositions.size === 0 && vPositions.size === 0) return;

    const make = go.GraphObject.make;
    const pad = 600;
    const db = d.documentBounds;
    const minX = db.left - pad;
    const maxX = db.right + pad;
    const minY = db.top - pad;
    const maxY = db.bottom + pad;
    const newGuides: go.Part[] = [];

    const prev = d.skipsUndoManager;
    d.skipsUndoManager = true;
    d.startTransaction('guides');

    hPositions.forEach(y => {
      const g = make(go.Part, go.Panel.Position,
        { layerName: 'Tool', selectable: false, pickable: false, isInDocumentBounds: false,
          position: new go.Point(minX, y - 0.5) },
        make(go.Shape, { width: maxX - minX, height: 1, fill: this._guideStroke, stroke: null, opacity: 0.7 })
      );
      d.add(g);
      newGuides.push(g);
    });

    vPositions.forEach(x => {
      const g = make(go.Part, go.Panel.Position,
        { layerName: 'Tool', selectable: false, pickable: false, isInDocumentBounds: false,
          position: new go.Point(x - 0.5, minY) },
        make(go.Shape, { width: 1, height: maxY - minY, fill: this._guideStroke, stroke: null, opacity: 0.7 })
      );
      d.add(g);
      newGuides.push(g);
    });

    d.commitTransaction('guides');
    d.skipsUndoManager = prev;
    this._guides = newGuides;
  }
}

const SHAPE_COLORS: Record<ShapeType, string> = {
  rectangle: '#F47A30',
  circle: '#F47A30',
  diamond: '#F47A30',
  process: '#F47A30',
};

const SHAPE_LABELS: Record<ShapeType, string> = {
  rectangle: 'Rectangle',
  circle: 'Cercle',
  diamond: 'Losange',
  process: 'Processus',
};

// ─── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements AfterViewInit, OnDestroy {
  readonly diagramDiv = viewChild.required<ElementRef<HTMLDivElement>>('diagramDiv');
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  private diagram!: go.Diagram;
  private _nodeCounter = 0;
  private _groupCounter = 0;
  private _linkCounter = 0;

  // ─── Selection state ───────────────────────────────────────────────────────

  private readonly _selNodeCount = signal(0);
  private readonly _selGroupCount = signal(0);
  private readonly _selLinkCount = signal(0);
  private readonly _selNodeData = signal<NodeData | null>(null);
  private readonly _selGroupData = signal<GroupData | null>(null);

  readonly selNodeData = computed(() => this._selNodeData());
  readonly selGroupData = computed(() => this._selGroupData());
  readonly selectionCount = computed(
    () => this._selNodeCount() + this._selGroupCount() + this._selLinkCount()
  );
  readonly canGroup = computed(
    () => this._selNodeCount() >= 2 && this._selGroupCount() === 0
  );
  readonly canUngroup = computed(
    () => this._selGroupCount() > 0 && this._selNodeCount() === 0
  );
  readonly hasSelection = computed(
    () => this._selNodeCount() + this._selGroupCount() + this._selLinkCount() > 0
  );

  // ─── Stats ─────────────────────────────────────────────────────────────────

  readonly nodeCount = signal(0);
  readonly groupCount = signal(0);
  readonly linkCount = signal(0);

  // ─── Toast ─────────────────────────────────────────────────────────────────

  readonly toast = signal<string | null>(null);
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;
  // ─── Layout menu ──────────────────────────────────────────────────────────

  readonly layoutMenuOpen = signal(false);

  @HostListener('document:click', ['$event.target'])
  onDocClick(target: EventTarget | null): void {
    if (!(target as HTMLElement)?.closest?.('.layout-menu')) {
      this.layoutMenuOpen.set(false);
    }
  }
  // ─── Model change handler (retained to allow removal) ──────────────────────

  private readonly _modelChangedHandler = (e: go.ChangedEvent) => {
    if (e.isTransactionFinished) {
      this._updateStats();
      this._autoSave();
    }
  };

  constructor(private readonly ngZone: NgZone) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    this.ngZone.runOutsideAngular(() => {
      try {
        this._initDiagram();
      } catch (err) {
        this._showToast(`Init GoJS: ${(err as Error).message}`);
        return;
      }
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        try {
          this._restoreFromFile(JSON.parse(saved));
        } catch {
          /* ignore corrupt data */
        }
      }
    });
  }

  ngOnDestroy(): void {
    if (this.diagram) {
      this.diagram.div = null as unknown as HTMLDivElement;
    }
  }

  // ─── Diagram initialization ────────────────────────────────────────────────

  private _initDiagram(): void {
    const div = this.diagramDiv().nativeElement;
    this._showToast(`Canvas: ${div.clientWidth}×${div.clientHeight}`);

    this.diagram = new go.Diagram(div, {
      'undoManager.isEnabled': true,
      'toolManager.mouseWheelBehavior': go.WheelMode.Zoom,
      padding: new go.Margin(40),
    });

    // ── Custom command handler (arrow-key nudge) ──────────────────────────────

    const ch = new SnappingCommandHandler();
    ch.archetypeGroupData = { isGroup: true, label: 'Groupe', color: '#F47A30', loc: '0 0' } as GroupData;
    ch.copiesTree = true;
    ch.deletesTree = true;
    this.diagram.commandHandler = ch;

    // ── Grid background ───────────────────────────────────────────────────────

    const make = go.GraphObject.make;
    this.diagram.grid = make(go.Panel, 'Grid',
      { gridCellSize: new go.Size(GRID_SIZE, GRID_SIZE) },
      make(go.Shape, 'LineH', { stroke: '#dce5f0', strokeWidth: 0.5 }),
      make(go.Shape, 'LineV', { stroke: '#dce5f0', strokeWidth: 0.5 }),
      make(go.Shape, 'LineH', { stroke: '#bfcfe3', strokeWidth: 1, interval: 5 }),
      make(go.Shape, 'LineV', { stroke: '#bfcfe3', strokeWidth: 1, interval: 5 }),
    );

    // ── Grid snapping + guided dragging tool ──────────────────────────────────

    const dt = new GuidedDraggingTool();
    dt.isGridSnapEnabled = true;
    dt.gridSnapCellSize = new go.Size(GRID_SIZE, GRID_SIZE);
    this.diagram.toolManager.draggingTool = dt;

    // ── Node templates ───────────────────────────────────────────────────────

    this.diagram.nodeTemplateMap.add(
      'rectangle',
      this._makeNodeTemplate('RoundedRectangle', 140, 50)
    );
    this.diagram.nodeTemplateMap.add(
      'circle',
      this._makeNodeTemplate('Ellipse', 80, 80)
    );
    this.diagram.nodeTemplateMap.add(
      'diamond',
      this._makeNodeTemplate('Diamond', 90, 90)
    );
    this.diagram.nodeTemplateMap.add(
      'process',
      this._makeNodeTemplate('Capsule', 160, 50)
    );

    // ── Group template ───────────────────────────────────────────────────────

    this.diagram.groupTemplate = this._makeGroupTemplate();

    // ── Link template ────────────────────────────────────────────────────────

    this.diagram.linkTemplate = this._makeLinkTemplate();

    // ── Model ────────────────────────────────────────────────────────────────

    this._setModel([], []);

    // ── Unique key generators ────────────────────────────────────────────────

    this.diagram.model.makeUniqueKeyFunction = (_model, data) => {
      if ((data as GroupData).isGroup) {
        this._groupCounter++;
        return `group-${this._groupCounter}`;
      }
      this._nodeCounter++;
      return `node-${this._nodeCounter}`;
    };

    (this.diagram.model as go.GraphLinksModel).makeUniqueLinkKeyFunction = (
      _model,
      _data
    ) => {
      this._linkCounter++;
      return `link-${this._linkCounter}`;
    };

    // ── Listeners ────────────────────────────────────────────────────────────

    this.diagram.addDiagramListener('ChangedSelection', () => {
      this._onSelectionChange();
    });

    this.diagram.addDiagramListener('SelectionGrouped', (e) => {
      const group = e.subject as go.Group;
      if (group?.data) {
        this.diagram.model.setDataProperty(
          group.data,
          'label',
          `Groupe ${this._groupCounter}`
        );
      }
    });

    this.diagram.addDiagramListener('LinkDrawn', () => {
      this._updateStats();
    });

    this.diagram.model.addChangedListener(this._modelChangedHandler);
  }

  // ─── Node template builder ─────────────────────────────────────────────────

  private _makeNodeTemplate(figure: string, width: number, height: number): go.Node {
    const make = go.GraphObject.make;
    return make(
      go.Node,
      go.Panel.Spot,
      {
        locationSpot: go.Spot.Center,
        selectionObjectName: 'BODY',
        resizable: false,
        rotatable: false,
        fromLinkable: false,
        toLinkable: false,
        toolTip: null,
        avoidableMargin: new go.Margin(12),
        // ── No external adornment box — state encoded inline on BODY ──────────
        selectionAdornmentTemplate: make(go.Adornment, 'Auto'),
        mouseEnter: (_: go.InputEvent, obj: go.GraphObject) => {
          const body = (obj as go.Node).findObject('BODY') as go.Shape | null;
          if (body) body.strokeWidth = 3;
        },
        mouseLeave: (_: go.InputEvent, obj: go.GraphObject) => {
          const node = obj as go.Node;
          const body = node.findObject('BODY') as go.Shape | null;
          if (body) body.strokeWidth = node.isSelected ? 3 : 2;
        },
      },
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(
        go.Point.stringify
      ),
      // Main shape
      make(
        go.Shape,
        figure,
        {
          name: 'BODY',
          width,
          height,
          strokeWidth: 2,
          fill: 'white',
        },
        new go.Binding('stroke', 'color'),
        new go.Binding('strokeWidth', 'isSelected', (sel: boolean) => sel ? 3 : 2).ofObject(),
        new go.Binding('fill', 'isSelected', (sel: boolean) =>
          sel ? '#FFF4EE' : 'white'
        ).ofObject()
      ),
      // Label
      make(
        go.TextBlock,
        {
          font: '500 12px Inter, Segoe UI, sans-serif',
          stroke: '#1e2c3a',
          textAlign: 'center',
          overflow: go.TextOverflow.Ellipsis,
          maxSize: new go.Size(width - 16, Number.NaN),
          editable: true,
          isMultiline: false,
        },
        new go.Binding('text', 'label').makeTwoWay()
      ),
      // Input port (left)
      make(go.Shape, 'Circle', {
        portId: 'in',
        alignment: go.Spot.Left,
        toSpot: go.Spot.LeftSide,
        fromLinkable: false,
        toLinkable: true,
        toLinkableSelfNode: false,
        width: 10,
        height: 10,
        fill: 'white',
        stroke: '#99b0c8',
        strokeWidth: 2,
        cursor: 'pointer',
      }),
      // Output port (right)
      make(go.Shape, 'Circle', {
        portId: 'out',
        alignment: go.Spot.Right,
        fromSpot: go.Spot.RightSide,
        fromLinkable: true,
        toLinkable: false,
        fromLinkableSelfNode: false,
        width: 10,
        height: 10,
        fill: '#F47A30',
        stroke: '#d45a10',
        strokeWidth: 2,
        cursor: 'crosshair',
      })
    );
  }

  // ─── Group template builder ────────────────────────────────────────────────

  private _makeGroupTemplate(): go.Group {
    const make = go.GraphObject.make;
    return make(
      go.Group,
      go.Panel.Auto,
      {
        ungroupable: true,
        locationSpot: go.Spot.TopLeft,
        selectionObjectName: 'GROUP_BORDER',
        computesBoundsAfterDrag: true,
        handlesDragDropForMembers: true,
      },
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(
        go.Point.stringify
      ),
      // Border shape
      make(
        go.Shape,
        'RoundedRectangle',
        {
          name: 'GROUP_BORDER',
          strokeWidth: 2,
          strokeDashArray: [5, 3],
          parameter1: 6,
          fill: 'rgba(44,62,80,0.05)',
        },
        new go.Binding('stroke', 'color'),
        new go.Binding('fill', 'color', (c: string) => c + '18')
      ),
      make(
        go.Panel,
        go.Panel.Vertical,
        { defaultAlignment: go.Spot.Left },
        // Header
        make(
          go.Panel,
          go.Panel.Auto,
          { stretch: go.Stretch.Horizontal },
          make(
            go.Shape,
            'RoundedRectangle',
            {
              fill: '#2C3E50',
              strokeWidth: 0,
              minSize: new go.Size(100, 26),
              parameter1: 4,
            },
            new go.Binding('fill', 'color')
          ),
          make(
            go.TextBlock,
            {
              font: 'bold 11px Inter, Segoe UI, sans-serif',
              stroke: 'white',
              margin: new go.Margin(5, 10),
              editable: true,
              isMultiline: false,
            },
            new go.Binding('text', 'label').makeTwoWay()
          )
        ),
        // Content placeholder
        make(go.Placeholder, {
          padding: new go.Margin(10, 16, 14, 16),
        })
      )
    );
  }

  // ─── Link template builder ─────────────────────────────────────────────────

  private _makeLinkTemplate(): go.Link {
    const make = go.GraphObject.make;
    return make(
      go.Link,
      {
        routing: go.Routing.AvoidsNodes,
        adjusting: go.LinkAdjusting.Stretch,
        fromEndSegmentLength: 20,
        toEndSegmentLength: 20,
        toShortLength: 4,
        relinkableFrom: true,
        relinkableTo: true,
        reshapable: false,
        corner: 8,
      },
      make(go.Shape, { strokeWidth: 2.5, stroke: '#F47A30' }),
      make(go.Shape, {
        toArrow: 'Standard',
        fill: '#F47A30',
        stroke: null,
        scale: 1.2,
      })
    );
  }

  // ─── Model helpers ─────────────────────────────────────────────────────────

  private _setModel(
    nodeDataArray: (NodeData | GroupData)[],
    linkDataArray: LinkData[]
  ): void {
    if (this.diagram.model) {
      this.diagram.model.removeChangedListener(this._modelChangedHandler);
    }
    const model = new go.GraphLinksModel({
      nodeKeyProperty: 'key',
      linkKeyProperty: 'key',
      linkFromPortIdProperty: 'fromPort',
      linkToPortIdProperty: 'toPort',
      nodeDataArray: nodeDataArray.map((d) => ({ ...d })),
      linkDataArray: linkDataArray.map((d) => ({ ...d })),
    });
    model.makeUniqueKeyFunction = (_m, data) => {
      if ((data as GroupData).isGroup) {
        this._groupCounter++;
        return `group-${this._groupCounter}`;
      }
      this._nodeCounter++;
      return `node-${this._nodeCounter}`;
    };
    model.makeUniqueLinkKeyFunction = () => {
      this._linkCounter++;
      return `link-${this._linkCounter}`;
    };
    model.addChangedListener(this._modelChangedHandler);
    this.diagram.model = model;
  }

  // ─── Selection change ──────────────────────────────────────────────────────

  private _onSelectionChange(): void {
    const sel = this.diagram.selection.toArray();
    const nodes = sel.filter(
      (p) => p instanceof go.Node && !(p instanceof go.Group)
    );
    const groups = sel.filter((p) => p instanceof go.Group);
    const links = sel.filter((p) => p instanceof go.Link);

    this._selNodeCount.set(nodes.length);
    this._selGroupCount.set(groups.length);
    this._selLinkCount.set(links.length);

    this._selNodeData.set(
      nodes.length === 1 ? ({ ...nodes[0].data } as NodeData) : null
    );
    this._selGroupData.set(
      groups.length === 1 && nodes.length === 0
        ? ({ ...groups[0].data } as GroupData)
        : null
    );
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  private _updateStats(): void {
    const model = this.diagram.model as go.GraphLinksModel;
    const allNodes = (model.nodeDataArray as (NodeData | GroupData)[]);
    this.nodeCount.set(allNodes.filter((d) => !d.isGroup).length);
    this.groupCount.set(allNodes.filter((d) => d.isGroup).length);
    this.linkCount.set(model.linkDataArray.length);
  }

  private _autoSave(): void {
    localStorage.setItem(LS_KEY, JSON.stringify(this._serializeToFile()));
  }

  // ─── Shape actions ─────────────────────────────────────────────────────────

  addNode(type: ShapeType): void {
    try {
      this._nodeCounter++;
      const nodeData: go.ObjectData = {
        key: `node-${this._nodeCounter}`,
        label: `${SHAPE_LABELS[type]} ${this._nodeCounter}`,
        category: type,
        color: SHAPE_COLORS[type],
        loc: '0 0',
      };
      this.diagram.startTransaction('add node');
      this.diagram.model.addNodeData(nodeData);
      this.diagram.commitTransaction('add node');
      this._showToast(`${SHAPE_LABELS[type]} ajouté`);
    } catch (err) {
      this._showToast(`Erreur ajout: ${(err as Error).message}`);
    }
  }

  // ─── Group actions ─────────────────────────────────────────────────────────

  groupSelected(): void {
    this.diagram.commandHandler.groupSelection();
  }

  ungroupSelected(): void {
    this.diagram.commandHandler.ungroupSelection();
  }

  // ─── Delete action ─────────────────────────────────────────────────────────

  deleteSelected(): void {
    this.diagram.commandHandler.deleteSelection();
    this._onSelectionChange();
  }

  // ─── Properties panel ──────────────────────────────────────────────────────

  updateNodeLabel(label: string): void {
    const nodeData = this._selNodeData();
    if (!nodeData) return;
    const data = this.diagram.model.findNodeDataForKey(nodeData.key);
    if (data) {
      this.diagram.model.commit((m) => m.setDataProperty(data, 'label', label), 'update label');
      this._selNodeData.update((d) => (d ? { ...d, label } : null));
    }
  }

  updateNodeColor(color: string): void {
    const nodeData = this._selNodeData();
    if (!nodeData) return;
    const data = this.diagram.model.findNodeDataForKey(nodeData.key);
    if (data) {
      this.diagram.model.commit((m) => m.setDataProperty(data, 'color', color), 'update color');
      this._selNodeData.update((d) => (d ? { ...d, color } : null));
    }
  }

  updateGroupLabel(label: string): void {
    const groupData = this._selGroupData();
    if (!groupData) return;
    const data = this.diagram.model.findNodeDataForKey(groupData.key);
    if (data) {
      this.diagram.model.commit((m) => m.setDataProperty(data, 'label', label), 'update label');
      this._selGroupData.update((d) => (d ? { ...d, label } : null));
    }
  }

  updateGroupColor(color: string): void {
    const groupData = this._selGroupData();
    if (!groupData) return;
    const data = this.diagram.model.findNodeDataForKey(groupData.key);
    if (data) {
      this.diagram.model.commit((m) => m.setDataProperty(data, 'color', color), 'update color');
      this._selGroupData.update((d) => (d ? { ...d, color } : null));
    }
  }

  // ─── Layout ─────────────────────────────────────────────────────────────────

  applyLayout(type: LayoutType): void {
    this.layoutMenuOpen.set(false);
    let layout: go.Layout;
    switch (type) {
      case 'tree':
        layout = new go.TreeLayout({
          isOngoing: false,
          setsPortSpot: false,
          setsChildPortSpot: false,
          angle: 90,
          layerSpacing: 40,
          nodeSpacing: 20,
        });
        break;
      case 'layered':
        layout = new go.LayeredDigraphLayout({
          isOngoing: false,
          setsPortSpots: false,
          direction: 90,
          layerSpacing: 40,
          columnSpacing: 20,
        });
        break;
      case 'force':
        layout = new go.ForceDirectedLayout({
          isOngoing: false,
          defaultSpringLength: 80,
          defaultElectricalCharge: 200,
        });
        break;
      case 'circular':
        layout = new go.CircularLayout({
          isOngoing: false,
          radius: 150,
          spacing: 20,
        });
        break;
      case 'grid':
        layout = new go.GridLayout({
          isOngoing: false,
          wrappingColumn: 5,
          cellSize: new go.Size(20, 20),
          spacing: new go.Size(20, 20),
        });
        break;
    }
    this.diagram.layout = layout;
    this.diagram.layoutDiagram(true);
    // Erase all stored waypoints so links re-route via template settings
    this.diagram.startTransaction('clear routes');
    this.diagram.links.each(link => link.clearPoints());
    this.diagram.commitTransaction('clear routes');
    this._showToast('Mise en forme appliquée');
  }

  // ─── Zoom ──────────────────────────────────────────────────────────────────

  zoomIn(): void {
    this.diagram.commandHandler.increaseZoom();
  }

  zoomOut(): void {
    this.diagram.commandHandler.decreaseZoom();
  }

  resetZoom(): void {
    this.diagram.commandHandler.resetZoom();
  }

  // ─── New diagram ───────────────────────────────────────────────────────────

  newDiagram(): void {
    const model = this.diagram.model as go.GraphLinksModel;
    if (model.nodeDataArray.length > 0 || model.linkDataArray.length > 0) {
      if (
        !confirm(
          'Créer un nouveau diagramme ? Les modifications non sauvegardées seront perdues.'
        )
      ) {
        return;
      }
    }
    this._nodeCounter = 0;
    this._groupCounter = 0;
    this._linkCounter = 0;
    this._setModel([], []);
    localStorage.removeItem(LS_KEY);
    this.ngZone.run(() => {
      this._updateStats();
      this._onSelectionChange();
    });
  }

  // ─── Save / Load ───────────────────────────────────────────────────────────

  saveDiagram(): void {
    const data = this._serializeToFile();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram-${new Date()
      .toISOString()
      .slice(0, 19)
      .replaceAll(/[:T]/gu, '-')}.gojs.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._showToast('Diagramme sauvegardé !');
  }

  loadDiagram(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        try {
          const data: DiagramFile = JSON.parse(text) as DiagramFile;
          if (data.version !== '1.0' || !Array.isArray(data.nodeDataArray)) {
            this.ngZone.run(() => this._showToast('Fichier invalide.'));
            return;
          }
          this._restoreFromFile(data);
          localStorage.setItem(LS_KEY, JSON.stringify(data));
          this.ngZone.run(() => this._showToast('Diagramme chargé !'));
        } catch {
          this.ngZone.run(() => this._showToast('Erreur de lecture du fichier.'));
        }
        input.value = '';
      })
      .catch(() => {
        this.ngZone.run(() => this._showToast('Erreur de lecture du fichier.'));
      });
  }

  private _serializeToFile(): DiagramFile {
    const model = this.diagram.model as go.GraphLinksModel;
    return {
      version: '1.0',
      engine: 'gojs',
      nodeDataArray: (model.nodeDataArray as (NodeData | GroupData)[]).map(
        (d) => ({ ...d })
      ),
      linkDataArray: (model.linkDataArray as LinkData[]).map((d) => ({ ...d })),
    };
  }

  private _restoreFromFile(data: DiagramFile): void {
    const maxCounter = (prefix: string, keys: string[]) =>
      keys.reduce(
        (max, k) =>
          Math.max(max, Number.parseInt(k?.replace(prefix, '') ?? '0', 10) || 0),
        0
      );

    this._nodeCounter = maxCounter(
      'node-',
      data.nodeDataArray.filter((d) => !d.isGroup).map((d) => d.key)
    );
    this._groupCounter = maxCounter(
      'group-',
      data.nodeDataArray.filter((d) => d.isGroup).map((d) => d.key)
    );
    this._linkCounter = maxCounter(
      'link-',
      data.linkDataArray.map((d) => d.key)
    );

    this._setModel(data.nodeDataArray, data.linkDataArray);
    this.ngZone.run(() => {
      this._updateStats();
      this._onSelectionChange();
    });
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────

  private _showToast(msg: string): void {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this.toast.set(msg);
    this._toastTimer = setTimeout(() => this.toast.set(null), 2500);
  }
}

