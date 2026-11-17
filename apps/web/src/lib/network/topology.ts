import { MAX_NETWORK_EDGES, MAX_NETWORK_NODES, type NetworkData } from './schema';

export function appendNetworkNode(data: NetworkData): NetworkData {
    if (data.nodes.length >= MAX_NETWORK_NODES) throw new Error('The node limit has been reached.');
    const ids = new Set(data.nodes.map((node) => node.id));
    let number = 1;
    while (ids.has(`node-${number}`)) number++;
    return {
        nodes: [...data.nodes, { id: `node-${number}`, label: `Node ${number}` }],
        edges: data.edges
    };
}

export function removeNetworkNode(data: NetworkData, id: string): NetworkData {
    if (!data.nodes.some((node) => node.id === id)) return data;
    if (data.nodes.length === 1) throw new Error('Keep at least one node.');
    return {
        nodes: data.nodes.filter((node) => node.id !== id),
        edges: data.edges.filter((edge) => edge.source !== id && edge.target !== id)
    };
}

export function appendNetworkLink(data: NetworkData, source: string, target: string): NetworkData {
    if (data.edges.length >= MAX_NETWORK_EDGES) throw new Error('The link limit has been reached.');
    if (![source, target].every((id) => data.nodes.some((node) => node.id === id)))
        throw new Error('Choose an existing node for each end of the link.');
    return { nodes: data.nodes, edges: [...data.edges, { source, target }] };
}
