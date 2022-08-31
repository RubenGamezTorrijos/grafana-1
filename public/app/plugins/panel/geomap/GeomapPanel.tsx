import { css } from '@emotion/css';
import { Global } from '@emotion/react';
import { Map as OpenLayersMap, MapBrowserEvent, PluggableMap, View } from 'ol';
import { FeatureLike } from 'ol/Feature';
import Attribution from 'ol/control/Attribution';
import ScaleLine from 'ol/control/ScaleLine';
import Zoom from 'ol/control/Zoom';
import MouseWheelZoom from 'ol/interaction/MouseWheelZoom';
import React, { Component, ReactNode } from 'react';
import { Subject, Subscription } from 'rxjs';

import { DataHoverEvent, GrafanaTheme, MapLayerOptions, PanelData, PanelProps } from '@grafana/data';
import { config } from '@grafana/runtime';
import { PanelContext, PanelContextRoot, stylesFactory } from '@grafana/ui';
import { PanelEditExitedEvent } from 'app/types/events';

import { GeomapOverlay, OverlayProps } from './GeomapOverlay';
import { GeomapTooltip } from './GeomapTooltip';
import { DebugOverlay } from './components/DebugOverlay';
import { MeasureOverlay } from './components/MeasureOverlay';
import { GeomapHoverPayload } from './event';
import { getGlobalStyles } from './globalStyles';
import { defaultMarkersConfig, MARKERS_LAYER_ID } from './layers/data/markersLayer';
import { DEFAULT_BASEMAP_CONFIG, geomapLayerRegistry } from './layers/registry';
import { ControlsOptions, GeomapPanelOptions, MapLayerState, TooltipMode } from './types';
import { getActions } from './utils/actions';
import { applyLayerFilter } from './utils/layers';
import { pointerClickListener, pointerMoveListener, setTooltipListeners } from './utils/tootltip';
import { updateMap, getNewOpenLayersMap, notifyPanelEditor, getNextLayerName } from './utils/utils';
import { initMapView, initViewExtent } from './utils/view';

// Allows multiple panels to share the same view instance
let sharedView: View | undefined = undefined;

type Props = PanelProps<GeomapPanelOptions>;
interface State extends OverlayProps {
  ttip?: GeomapHoverPayload;
  ttipOpen: boolean;
  legends: ReactNode[];
  measureMenuActive?: boolean;
}

export class GeomapPanel extends Component<Props, State> {
  static contextType = PanelContextRoot;
  panelContext: PanelContext = {} as PanelContext;
  private subs = new Subscription();

  globalCSS = getGlobalStyles(config.theme2);

  mouseWheelZoom?: MouseWheelZoom;
  style = getStyles(config.theme);
  hoverPayload: GeomapHoverPayload = { point: {}, pageX: -1, pageY: -1 };
  readonly hoverEvent = new DataHoverEvent(this.hoverPayload);

  map?: OpenLayersMap;
  mapDiv?: HTMLDivElement;
  layers: MapLayerState[] = [];
  readonly byName = new Map<string, MapLayerState>();

  constructor(props: Props) {
    super(props);
    this.state = { ttipOpen: false, legends: [] };
    this.subs.add(
      this.props.eventBus.subscribe(PanelEditExitedEvent, (evt) => {
        if (this.mapDiv && this.props.id === evt.payload) {
          this.initMapRef(this.mapDiv);
        }
      })
    );
  }

  componentDidMount() {
    this.panelContext = this.context as PanelContext;
  }

  componentWillUnmount() {
    this.subs.unsubscribe();
    for (const lyr of this.layers) {
      lyr.handler.dispose?.();
    }
  }

  shouldComponentUpdate(nextProps: Props) {
    if (!this.map) {
      return true; // not yet initialized
    }

    // Check for resize
    if (this.props.height !== nextProps.height || this.props.width !== nextProps.width) {
      this.map.updateSize();
    }

    // External data changed
    if (this.props.data !== nextProps.data) {
      this.dataChanged(nextProps.data);
    }

    // Options changed
    if (this.props.options !== nextProps.options) {
      this.optionsChanged(nextProps.options);
    }

    return true; // always?
  }

  componentDidUpdate(prevProps: Props) {
    if (this.map && (this.props.height !== prevProps.height || this.props.width !== prevProps.width)) {
      this.map.updateSize();
    }
    // Check for a difference between previous data and component data
    if (this.map && this.props.data !== prevProps.data) {
      this.dataChanged(this.props.data);
    }
  }

  /** This function will actually update the JSON model */
  doOptionsUpdate(selected: number) {
    const { options, onOptionsChange } = this.props;
    const layers = this.layers;
    onOptionsChange({
      ...options,
      basemap: layers[0].options,
      layers: layers.slice(1).map((v) => v.options),
    });

    notifyPanelEditor(this, layers, selected);
    this.setState({ legends: this.getLegends() });
  }

  actions = getActions(this);

  /**
   * Called when the panel options change
   *
   * NOTE: changes to basemap and layers are handled independently
   */
  optionsChanged(options: GeomapPanelOptions) {
    const oldOptions = this.props.options;
    if (options.view !== oldOptions.view) {
      const [updatedSharedView, view] = initMapView(options.view, sharedView, this.map!.getLayers());
      sharedView = updatedSharedView;
      this.map!.setView(view as View);
    }

    if (options.controls !== oldOptions.controls) {
      this.initControls(options.controls ?? { showZoom: true, showAttribution: true });
    }
  }

  /**
   * Called when PanelData changes (query results etc)
   */
  dataChanged(data: PanelData) {
    // Only update if panel data matches component data
    if (data === this.props.data) {
      for (const state of this.layers) {
        applyLayerFilter(state.handler, state.options, this.props.data);
      }
    }
  }

  initMapRef = async (div: HTMLDivElement) => {
    this.mapDiv = div;
    if (this.map) {
      this.map.dispose();
    }

    if (!div) {
      this.map = undefined as unknown as OpenLayersMap;
      return;
    }
    const { options } = this.props;

    const map = getNewOpenLayersMap(this, options, div);

    this.byName.clear();
    const layers: MapLayerState[] = [];
    try {
      layers.push(await this.initLayer(map, options.basemap ?? DEFAULT_BASEMAP_CONFIG, true));

      // Default layer values
      const layerOptions = options.layers ?? [defaultMarkersConfig];

      for (const lyr of layerOptions) {
        layers.push(await this.initLayer(map, lyr, false));
      }
    } catch (ex) {
      console.error('error loading layers', ex);
    }

    for (const lyr of layers) {
      map.addLayer(lyr.layer);
    }
    this.layers = layers;
    this.map = map; // redundant
    initViewExtent(map.getView(), options.view, map.getLayers());

    this.mouseWheelZoom = new MouseWheelZoom();
    this.map?.addInteraction(this.mouseWheelZoom);

    updateMap(this, options);
    setTooltipListeners(this);
    notifyPanelEditor(this, layers, layers.length - 1);

    this.setState({ legends: this.getLegends() });
  };

  clearTooltip = () => {
    if (this.state.ttip && !this.state.ttipOpen) {
      this.tooltipPopupClosed();
    }
  };

  tooltipPopupClosed = () => {
    this.setState({ ttipOpen: false, ttip: undefined });
  };

  pointerClickListener = (evt: MapBrowserEvent<UIEvent>) => {
    pointerClickListener(evt, this);
  };

  pointerMoveListener = (evt: MapBrowserEvent<UIEvent>) => {
    pointerMoveListener(evt, this);
  };

  private updateLayer = async (uid: string, newOptions: MapLayerOptions): Promise<boolean> => {
    if (!this.map) {
      return false;
    }
    const current = this.byName.get(uid);
    if (!current) {
      return false;
    }

    let layerIndex = -1;
    const group = this.map?.getLayers()!;
    for (let i = 0; i < group?.getLength(); i++) {
      if (group.item(i) === current.layer) {
        layerIndex = i;
        break;
      }
    }

    // Special handling for rename
    if (newOptions.name !== uid) {
      if (!newOptions.name) {
        newOptions.name = uid;
      } else if (this.byName.has(newOptions.name)) {
        return false;
      }
      this.byName.delete(uid);

      uid = newOptions.name;
      this.byName.set(uid, current);
    }

    // Type changed -- requires full re-initalization
    if (current.options.type !== newOptions.type) {
      // full init
    } else {
      // just update options
    }

    const layers = this.layers.slice(0);
    try {
      const info = await this.initLayer(this.map, newOptions, current.isBasemap);
      layers[layerIndex]?.handler.dispose?.();
      layers[layerIndex] = info;
      group.setAt(layerIndex, info.layer);

      // initialize with new data
      applyLayerFilter(info.handler, newOptions, this.props.data);
    } catch (err) {
      console.warn('ERROR', err);
      return false;
    }

    // Just to trigger a state update
    this.setState({ legends: [] });

    this.layers = layers;
    this.doOptionsUpdate(layerIndex);
    return true;
  };

  async initLayer(map: PluggableMap, options: MapLayerOptions, isBasemap?: boolean): Promise<MapLayerState> {
    if (isBasemap && (!options?.type || config.geomapDisableCustomBaseLayer)) {
      options = DEFAULT_BASEMAP_CONFIG;
    }

    // Use default makers layer
    if (!options?.type) {
      options = {
        type: MARKERS_LAYER_ID,
        name: getNextLayerName(this),
        config: {},
      };
    }

    const item = geomapLayerRegistry.getIfExists(options.type);
    if (!item) {
      return Promise.reject('unknown layer: ' + options.type);
    }

    const handler = await item.create(map, options, this.props.eventBus, config.theme2);
    const layer = handler.init();
    if (options.opacity != null) {
      layer.setOpacity(options.opacity);
    }

    if (!options.name) {
      options.name = getNextLayerName(this);
    }

    const UID = options.name;
    const state: MapLayerState<unknown> = {
      // UID, // unique name when added to the map (it may change and will need special handling)
      isBasemap,
      options,
      layer,
      handler,
      mouseEvents: new Subject<FeatureLike | undefined>(),

      getName: () => UID,

      // Used by the editors
      onChange: (cfg: MapLayerOptions) => {
        this.updateLayer(UID, cfg);
      },
    };

    this.byName.set(UID, state);
    (state.layer as any).__state = state;

    applyLayerFilter(handler, options, this.props.data);

    return state;
  }

  initControls(options: ControlsOptions) {
    if (!this.map) {
      return;
    }
    this.map.getControls().clear();

    if (options.showZoom) {
      this.map.addControl(new Zoom());
    }

    if (options.showScale) {
      this.map.addControl(
        new ScaleLine({
          units: options.scaleUnits,
          minWidth: 100,
        })
      );
    }

    this.mouseWheelZoom!.setActive(Boolean(options.mouseWheelZoom));

    if (options.showAttribution) {
      this.map.addControl(new Attribution({ collapsed: true, collapsible: true }));
    }

    // Update the react overlays
    let topRight1: ReactNode[] = [];
    if (options.showMeasure) {
      topRight1 = [
        <MeasureOverlay
          key="measure"
          map={this.map}
          // Lifts menuActive state and resets tooltip state upon close
          menuActiveState={(value: boolean) => {
            this.setState({ ttipOpen: value, measureMenuActive: value });
          }}
        />,
      ];
    }

    let topRight2: ReactNode[] = [];
    if (options.showDebug) {
      topRight2 = [<DebugOverlay key="debug" map={this.map} />];
    }

    this.setState({ topRight1, topRight2 });
  }

  getLegends() {
    const legends: ReactNode[] = [];
    for (const state of this.layers) {
      if (state.handler.legend) {
        legends.push(<div key={state.options.name}>{state.handler.legend}</div>);
      }
    }

    return legends;
  }

  render() {
    let { ttip, ttipOpen, topRight1, legends, topRight2 } = this.state;
    const { options } = this.props;
    const showScale = options.controls.showScale;
    if (!ttipOpen && options.tooltip?.mode === TooltipMode.None) {
      ttip = undefined;
    }

    return (
      <>
        <Global styles={this.globalCSS} />
        <div className={this.style.wrap} onMouseLeave={this.clearTooltip}>
          <div className={this.style.map} ref={this.initMapRef}></div>
          <GeomapOverlay
            bottomLeft={legends}
            topRight1={topRight1}
            topRight2={topRight2}
            blStyle={{ bottom: showScale ? '35px' : '8px' }}
          />
        </div>
        <GeomapTooltip ttip={ttip} isOpen={ttipOpen} onClose={this.tooltipPopupClosed} />
      </>
    );
  }
}

const getStyles = stylesFactory((theme: GrafanaTheme) => ({
  wrap: css`
    position: relative;
    width: 100%;
    height: 100%;
  `,
  map: css`
    position: absolute;
    z-index: 0;
    width: 100%;
    height: 100%;
  `,
}));
