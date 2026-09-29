from workers.connectors.base import BaseConnector
from workers.connectors.blinkit import BlinkitConnector
from workers.connectors.instamart import InstamartConnector

REGISTRY: dict[str, type[BaseConnector]] = {
    c.platform: c for c in (BlinkitConnector, InstamartConnector)
}


def connector_class(platform: str) -> type[BaseConnector]:
    return REGISTRY[platform]
